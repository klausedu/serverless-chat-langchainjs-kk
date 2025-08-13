import process from 'node:process';
import { HttpRequest, HttpResponseInit, InvocationContext, app } from '@azure/functions';
import { AzureCosmsosDBNoSQLChatMessageHistory } from '@langchain/azure-cosmosdb';
import { FileSystemChatMessageHistory } from '@langchain/community/stores/message/file_system';
import 'dotenv/config';
import { badRequest, ok, notFound, serviceUnavailable, data } from '../http-response.js';
import { getCredentials, getUserId } from '../security.js';

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

async function deleteChats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureCosmosDbEndpoint = process.env.AZURE_COSMOSDB_NOSQL_ENDPOINT;
  const { sessionId } = request.params;
  const userId = getUserId(request);

  if (!userId) {
    return badRequest('Invalid or missing userId in the request');
  }

  if (!sessionId) {
    return badRequest('Invalid or missing sessionId in the request');
  }

  try {
    let chatHistory;

    if (azureCosmosDbEndpoint) {
      const credentials = getCredentials();
      chatHistory = new AzureCosmsosDBNoSQLChatMessageHistory({
        sessionId,
        userId,
        credentials,
      });
    } else {
      // If no environment variables are set, it means we are running locally
      context.log('No Azure CosmosDB endpoint set, using local file');

      chatHistory = new FileSystemChatMessageHistory({
        sessionId,
        userId,
      });
    }

    await chatHistory.clear();
    return ok();
  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when processing chats-delete request: ${error.message}`);

    return notFound('Session not found');
  }
}

// Substitua a função deleteMessage inteira por esta versão melhorada:

export async function deleteMessage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureCosmosDbEndpoint = process.env.AZURE_COSMOSDB_NOSQL_ENDPOINT;
  
  try {
    // Log detalhado da requisição para debug
    context.log('=== DELETE MESSAGE REQUEST DEBUG ===');
    context.log(`URL: ${request.url}`);
    context.log(`Method: ${request.method}`);
    context.log(`Headers: ${JSON.stringify(Object.fromEntries(request.headers.entries()))}`);
    context.log(`Params: ${JSON.stringify(request.params)}`);
    
    // Extrair parâmetros da URL primeiro
    const { messageId: paramMessageId, sessionId: paramSessionId } = request.params;
    context.log(`URL Parameters - sessionId: ${paramSessionId}, messageId: ${paramMessageId}`);
    
    // Tentar ler o body, mas não falhar se estiver vazio
    let requestBody: any = {};
    let rawBody = '';
    
    try {
      rawBody = await request.text();
      context.log(`Raw body: "${rawBody}"`);
      
      if (rawBody && rawBody.trim() !== '' && rawBody.trim() !== '{}') {
        requestBody = JSON.parse(rawBody);
        context.log(`Parsed body: ${JSON.stringify(requestBody)}`);
      }
    } catch (parseError) {
      context.log(`Body parse warning (not critical): ${parseError}`);
    }

    // Priorizar parâmetros da URL sobre body
    const messageId = paramMessageId || requestBody.messageId;
    const sessionId = paramSessionId || requestBody.sessionId;
    
    context.log(`Final values - sessionId: ${sessionId}, messageId: ${messageId}`);

    if (!messageId) {
      context.error('messageId is missing from both URL params and body');
      return badRequest('messageId is required in URL path');
    }

    if (!sessionId) {
      context.error('sessionId is missing from both URL params and body');
      return badRequest('sessionId is required in URL path');
    }

    // Tentar obter userId - com múltiplas fontes
    let userId;
    try {
      userId = getUserId(request, requestBody) || 
               request.headers.get('X-User-Id') || 
               requestBody.userId;
      context.log(`Extracted userId: ${userId}`);
    } catch (userIdError) {
      context.error(`Error getting userId: ${userIdError}`);
      userId = request.headers.get('X-User-Id') || requestBody.userId;
      if (userId) {
        context.log(`Got userId from alternative source: ${userId}`);
      }
    }

    if (!userId) {
      context.error('userId is null or undefined after all attempts');
      return badRequest('Invalid or missing userId in the request. Please ensure userId is provided.');
    }

    let chatHistory;

    if (azureCosmosDbEndpoint) {
      context.log('Using Azure CosmosDB for chat history');
      const credentials = getCredentials();
      chatHistory = new AzureCosmsosDBNoSQLChatMessageHistory({
        sessionId,
        userId,
        credentials,
      });
    } else {
      context.log('Using local file system for chat history');
      chatHistory = new FileSystemChatMessageHistory({
        sessionId,
        userId,
      });
    }

    context.log('Fetching messages from chat history...');
    const messages = await chatHistory.getMessages();
    context.log(`Found ${messages?.length || 0} messages in session`);
    
    if (!messages || messages.length === 0) {
      context.log('No messages found in session');
      return badRequest('No messages found in the specified session');
    }
    
    // Log all message IDs for debugging
    context.log('Current message IDs in session:');
    messages.forEach((msg, index) => {
      const msgId = getMessageId(msg);
      context.log(`  [${index}] ID: ${msgId}`);
    });
    
    // Find the message to delete
    const messageToDelete = messages.find(msg => {
      const msgId = getMessageId(msg);
      return msgId === messageId;
    });
    
    if (!messageToDelete) {
      context.log(`Message with ID ${messageId} not found in session`);
      return badRequest(`Message with ID ${messageId} not found in session`);
    }
    
    context.log(`Found message to delete: ${JSON.stringify(messageToDelete, null, 2)}`);
    
    // Filter out the message
    const filteredMessages = messages.filter(msg => {
      const msgId = getMessageId(msg);
      return msgId !== messageId;
    });
    
    context.log(`Messages before deletion: ${messages.length}, after: ${filteredMessages.length}`);

    // IMPROVED APPROACH: Preserve all session metadata
    context.log('Preserving session metadata during message deletion...');
    
    // Extract session metadata from existing messages
    let sessionMetadata = {};
    const firstMessage = messages[0];
    if (firstMessage && firstMessage.additional_kwargs) {
      // Preserve session-level metadata
      sessionMetadata = {
        title: firstMessage.additional_kwargs.title,
        sessionId: firstMessage.additional_kwargs.sessionId || sessionId,
        userId: firstMessage.additional_kwargs.userId || userId,
        createdAt: firstMessage.additional_kwargs.createdAt,
        updatedAt: new Date().toISOString(),
        // Preserve any other metadata fields
        ...Object.fromEntries(
          Object.entries(firstMessage.additional_kwargs)
            .filter(([key]) => !['messageId', 'content', 'role'].includes(key))
        )
      };
      context.log(`Extracted session metadata: ${JSON.stringify(sessionMetadata, null, 2)}`);
    }

    try {
      // Clear the history
      await chatHistory.clear();
      context.log('Chat history cleared');
      
      // Re-add filtered messages with preserved metadata
      for (let i = 0; i < filteredMessages.length; i++) {
        const msg = filteredMessages[i];
        
        // Ensure each message has the session metadata
        if (!msg.additional_kwargs) {
          msg.additional_kwargs = {};
        }
        
        // Merge session metadata while preserving message-specific data
        msg.additional_kwargs = {
          ...sessionMetadata,
          ...msg.additional_kwargs,
          // Ensure message-specific fields aren't overwritten
          messageId: msg.additional_kwargs.messageId || getMessageId(msg),
          messageIndex: i,
          isFirst: i === 0,
          isLast: i === filteredMessages.length - 1
        };
        
        await chatHistory.addMessage(msg);
        context.log(`Re-added message ${i + 1}/${filteredMessages.length}`);
      }
      
      context.log('All filtered messages re-added with preserved metadata');
      
    } catch (_updateError: unknown) {
      const updateError = _updateError as Error;
      context.error(`Error during message deletion update: ${updateError.message}`);
      context.error(`Stack trace: ${updateError.stack}`);
      return serviceUnavailable('Failed to update chat history after message deletion');
    }

    context.log(`Successfully deleted message with ID: ${messageId} from session: ${sessionId}`);

    const responseBody = JSON.stringify({ 
      success: true, 
      deletedMessageId: messageId,
      remainingMessages: filteredMessages.length,
      preservedMetadata: Object.keys(sessionMetadata)
    });
    
    return data(new TextEncoder().encode(responseBody), {
      'Content-Type': 'application/json'
    });
    
  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when deleting message: ${error.message}`);
    context.error(`Stack trace: ${error.stack}`);
    return serviceUnavailable('Service temporarily unavailable. Please try again later.');
  }
}

app.http('chats-delete', {
  route: 'chats/{sessionId}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: deleteChats,
});

app.http('chats-delete-message', {
  route: 'chats/{sessionId}/messages/{messageId}',
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: deleteMessage,
});