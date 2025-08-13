import { Readable } from 'node:stream';
import { HttpRequest, InvocationContext, HttpResponseInit, app } from '@azure/functions';
import { AIChatCompletionRequest, AIChatCompletionDelta } from '@microsoft/ai-chat-protocol';
import { AzureOpenAIEmbeddings, AzureChatOpenAI } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';
import { AzureCosmsosDBNoSQLChatMessageHistory, AzureCosmosDBNoSQLVectorStore } from '@langchain/azure-cosmosdb';
import { FileSystemChatMessageHistory } from '@langchain/community/stores/message/file_system';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { VectorStore } from '@langchain/core/vectorstores';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { ChatPromptTemplate, PromptTemplate } from '@langchain/core/prompts';
import { createStuffDocumentsChain } from 'langchain/chains/combine_documents';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';
import { badRequest, data, serviceUnavailable } from '../http-response.js';
import { ollamaChatModel, ollamaEmbeddingsModel, faissStoreFolder } from '../constants.js';
import { getAzureOpenAiTokenProvider, getCredentials, getUserId } from '../security.js';

const ragSystemPrompt = `You are an expert assistant helping users by answering questions based exclusively on the provided source documents. Use ONLY the information contained in the sources. Do NOT fabricate or guess answers beyond the data available.

Your answers must be:
- Use ONLY the information contained in the sources. Do NOT fabricate or guess answers beyond the data available.
- Complete and detailed, explaining the concepts clearly.
- Professional and confident, with an expert tone.
- Helpful and engaging, offering additional insights, suggestions for further research, or clarifying questions when appropriate.
- Always include precise references to the source documents you used, using the format "[filename]" immediately after the relevant information.
- If the sources do not contain enough information to answer fully, politely acknowledge the limitation, suggest possible directions for further research, and offer to assist with related questions.
- Do NOT repeat questions already asked.
- Provide 3 brief and relevant follow-up questions the user might want to ask next. Enclose them in double angle brackets, like so:
<<What are the main benefits of this approach?>>
<<Can you provide examples from the documents?>>
<<How can I apply this in practice?>>
If the answer cannot be found in the sources or chat history, say politely that you don't have that information.

The source documents are formatted as: "[filename]: information".

Answer ONLY in plain text, without any Markdown or special formatting.

Use the same language as the user's question.

Do no repeat questions that have already been asked.
Make sure the last question ends with ">>".

SOURCES:
{context}`;

const titleSystemPrompt = `Create a title for this chat session, based on the user question. The title should be less than 32 characters. Do NOT use double-quotes.`;

// Helper function to safely get message ID
function getMessageId(msg: any): string {
  return (
    msg.additional_kwargs?.messageId ||
    msg.response_metadata?.messageId ||
    msg.messageId ||
    msg.id ||
    null
  );
}

// Helper function to set message ID consistently
function setMessageId(message: HumanMessage | AIMessage, messageId: string): void {
  message.additional_kwargs = { ...(message.additional_kwargs || {}), messageId };
  message.response_metadata = { ...(message.response_metadata || {}), messageId };
  (message as any).messageId = messageId;
}

export async function postChats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureOpenAiEndpoint = process.env.AZURE_OPENAI_API_ENDPOINT;

  try {
    const requestBody = (await request.json()) as AIChatCompletionRequest;
    const { messages, context: chatContext } = requestBody;
    const userId = getUserId(request, requestBody);

    if (!messages || messages.length === 0 || !messages.at(-1)?.content) {
      return badRequest('Invalid or missing messages in the request body');
    }

    let embeddings: Embeddings;
    let model: BaseChatModel;
    let store: VectorStore;
    let chatHistory;
    const sessionId = ((chatContext as any)?.sessionId as string) || uuidv4();
    context.log(`userId: ${userId}, sessionId: ${sessionId}`);

    if (azureOpenAiEndpoint) {
      const credentials = getCredentials();
      const azureADTokenProvider = getAzureOpenAiTokenProvider();

      embeddings = new AzureOpenAIEmbeddings({ azureADTokenProvider });
      model = new AzureChatOpenAI({
        temperature: 0,
        azureADTokenProvider,
      });
      store = new AzureCosmosDBNoSQLVectorStore(embeddings, { credentials });
      chatHistory = new AzureCosmsosDBNoSQLChatMessageHistory({
        sessionId,
        userId,
        credentials,
      });
    } else {
      context.log('No Azure OpenAI endpoint set, using Ollama models and local DB');
      embeddings = new OllamaEmbeddings({ model: ollamaEmbeddingsModel });
      model = new ChatOllama({
        temperature: 0.7,
        model: ollamaChatModel,
      });
      store = await FaissStore.load(faissStoreFolder, embeddings);
      chatHistory = new FileSystemChatMessageHistory({
        sessionId,
        userId,
      });
    }

    // Get current messages to check for duplicates
    const existingMessages = await chatHistory.getMessages();
    const userQuestion = messages.at(-1)!.content;

    // Check if this exact message already exists (prevent duplicates)
    const isDuplicate = existingMessages.some(msg => {
      const isHuman = msg.type === 'human';
      const content = msg.content || '';
      return isHuman && content.trim() === userQuestion.trim();
    });

    let userMessageId: string;

    if (!isDuplicate) {
      // Only add user message if it's not a duplicate
      userMessageId = uuidv4();
      const userMessage = new HumanMessage(userQuestion);
      setMessageId(userMessage, userMessageId);
      await chatHistory.addMessage(userMessage);
      context.log(`Added new user message with ID: ${userMessageId}`);
    } else {
      // Find the existing message ID
      const existingUserMsg = existingMessages
        .filter(msg => msg.type === 'human' && msg.content === userQuestion)
        .pop(); // Get the most recent one
      
      userMessageId = getMessageId(existingUserMsg) || uuidv4();
      context.log(`Using existing user message ID: ${userMessageId}`);
    }

    // Get updated message history for context
    const currentMessages = await chatHistory.getMessages();
    const historyText = currentMessages
      .map(msg => {
        const role = msg.type === 'human' ? 'User' : 'Assistant';
        const messageId = getMessageId(msg) || 'no-id';
        const content = msg.content || '';
        return `${role} (ID: ${messageId}): ${content}`;
      })
      .join('\n');

    // Create RAG chain
    const ragChain = await createStuffDocumentsChain({
      llm: model,
      prompt: ChatPromptTemplate.fromMessages([
        ['system', ragSystemPrompt],
        ['human', 'Context:\n{chat_history}\n\nQuestion:\n{input}'],
      ]),
      documentPrompt: PromptTemplate.fromTemplate('[{source}]: {page_content}\n'),
    });

    // DON'T use RunnableWithMessageHistory - it causes duplicates!
    // Use the chain directly instead
    const retriever = store.asRetriever(3);
    
    const responseStream = await ragChain.stream({
      input: userQuestion,
      chat_history: historyText,
      context: await retriever.invoke(userQuestion),
    });

    // Generate AI message ID
    const aiMessageId = uuidv4();
    const jsonStream = Readable.from(createJsonStream(responseStream, sessionId, aiMessageId, chatHistory, context));

    // Handle title generation
    const { title } = await chatHistory.getContext();
    if (!title) {
      const titleResponse = await ChatPromptTemplate.fromMessages([
        ['system', titleSystemPrompt],
        ['human', '{input}'],
      ])
        .pipe(model)
        .invoke({ input: userQuestion });
      context.log(`Title for session: ${titleResponse.content as string}`);
      chatHistory.setContext({ title: titleResponse.content });
    }

    return data(jsonStream, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    });
  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when processing chat-post request: ${error.message}`);
    return serviceUnavailable('Service temporarily unavailable. Please try again later.');
  }
}

// Fixed: Only add AI message once, at the end
async function* createJsonStream(
  chunks: AsyncIterable<string>, 
  sessionId: string, 
  messageId: string,
  chatHistory: any,
  context: InvocationContext
) {
  let fullResponse = '';
  
  for await (const chunk of chunks) {
    if (!chunk) continue;
    
    fullResponse += chunk;

    const responseChunk: AIChatCompletionDelta = {
      delta: {
        content: chunk,
        role: 'assistant',
      },
      context: {
        sessionId,
        messageId,
      },
    };

    yield JSON.stringify(responseChunk) + '\n';
  }
  
  // Only save AI message once, after streaming is complete
  if (fullResponse.trim()) {
    try {
      // Check if this AI response already exists to prevent duplicates
      const existingMessages = await chatHistory.getMessages();
      const responseAlreadyExists = existingMessages.some(msg => 
        msg.type === 'ai' && msg.content === fullResponse.trim()
      );

      if (!responseAlreadyExists) {
        const aiMessage = new AIMessage(fullResponse);
        setMessageId(aiMessage, messageId);
        await chatHistory.addMessage(aiMessage);
        context.log(`Added AI response with ID: ${messageId}`);
      } else {
        context.log(`AI response already exists, skipping duplicate`);
      }
    } catch (error) {
      context.error(`Error saving AI message: ${error}`);
    }
  }
}


export async function getMessagesWithIds(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureOpenAiEndpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
  
  try {
    const sessionId = request.query.get('sessionId');
    const userId = getUserId(request, {});

    if (!sessionId) {
      return badRequest('sessionId is required');
    }

    let chatHistory;

    if (azureOpenAiEndpoint) {
      const credentials = getCredentials();
      chatHistory = new AzureCosmsosDBNoSQLChatMessageHistory({
        sessionId,
        userId,
        credentials,
      });
    } else {
      chatHistory = new FileSystemChatMessageHistory({
        sessionId,
        userId,
      });
    }

    const messages = await chatHistory.getMessages();
    
    const messagesWithIds = messages.map(msg => {
      const msgId = getMessageId(msg) || uuidv4();
      
      return {
        id: msgId,
        content: msg.content || '',
        role: msg.type === 'human' ? 'user' : msg.type === 'ai' ? 'assistant' : 'unknown',
        timestamp: (msg as any).timestamp || new Date().toISOString(),
        type: msg.type,
      };
    });

    const responseBody = JSON.stringify({ messages: messagesWithIds });
    return data(new TextEncoder().encode(responseBody), {
      'Content-Type': 'application/json'
    });
    
  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when getting messages: ${error.message}`);
    return serviceUnavailable('Service temporarily unavailable. Please try again later.');
  }
}

// Utility function to clean up duplicates from existing sessions
export async function cleanupDuplicates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureOpenAiEndpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
  
  try {
    const requestBody = await request.json() as { sessionId: string };
    const { sessionId } = requestBody;
    const userId = getUserId(request, requestBody);

    if (!sessionId) {
      return badRequest('sessionId is required');
    }

    let chatHistory;

    if (azureOpenAiEndpoint) {
      const credentials = getCredentials();
      chatHistory = new AzureCosmsosDBNoSQLChatMessageHistory({
        sessionId,
        userId,
        credentials,
      });
    } else {
      chatHistory = new FileSystemChatMessageHistory({
        sessionId,
        userId,
      });
    }

    const messages = await chatHistory.getMessages();
    const uniqueMessages: (HumanMessage | AIMessage)[] = [];
    const seenContent = new Set<string>();

    // Remove duplicates based on content and type
    for (const msg of messages) {
      const key = `${msg.type}:${msg.content}`;
      if (!seenContent.has(key)) {
        seenContent.add(key);
        // Ensure message has an ID
        if (!getMessageId(msg)) {
          const newId = uuidv4();
          if (msg.type === 'human') {
            const humanMsg = new HumanMessage(msg.content);
            setMessageId(humanMsg, newId);
            uniqueMessages.push(humanMsg);
          } else if (msg.type === 'ai') {
            const aiMsg = new AIMessage(msg.content);
            setMessageId(aiMsg, newId);
            uniqueMessages.push(aiMsg);
          }
        } else {
          uniqueMessages.push(msg);
        }
      }
    }

    const removedCount = messages.length - uniqueMessages.length;

    if (removedCount > 0) {
      await chatHistory.clear();
      for (const msg of uniqueMessages) {
        await chatHistory.addMessage(msg);
      }
      context.log(`Removed ${removedCount} duplicate messages from session: ${sessionId}`);
    }

    const responseBody = JSON.stringify({ 
      success: true, 
      removedDuplicates: removedCount,
      totalMessages: uniqueMessages.length
    });
    return data(new TextEncoder().encode(responseBody), {
      'Content-Type': 'application/json'
    });
    
  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when cleaning duplicates: ${error.message}`);
    return serviceUnavailable('Service temporarily unavailable. Please try again later.');
  }
}

app.setup({ enableHttpStream: true });

app.http('chats-post', {
  route: 'chats/stream',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: postChats,
});

app.http('chats-get-messages', {
  route: 'chats/{sessionId}/messages',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: getMessagesWithIds,
});

app.http('chats-cleanup', {
  route: 'chats/{sessionId}/cleanup',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: cleanupDuplicates,
});