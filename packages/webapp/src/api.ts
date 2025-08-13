import { AIChatMessage, AIChatCompletionDelta, AIChatProtocolClient } from '@microsoft/ai-chat-protocol';

export const apiBaseUrl: string = import.meta.env.VITE_API_URL || '';

export type ChatRequestOptions = {
  messages: AIChatMessage[];
  context?: Record<string, unknown>;
  chunkIntervalMs: number;
  apiUrl: string;
};

export async function* getCompletion(options: ChatRequestOptions) {
  const apiUrl = options.apiUrl || apiBaseUrl;
  const client = new AIChatProtocolClient(`${apiUrl}/api/chats`);
  const result = await client.getStreamedCompletion(options.messages, { context: options.context });
  for await (const response of result) {
    if (!response.delta) {
      continue;
    }
    yield new Promise<AIChatCompletionDelta>((resolve) => {
      setTimeout(() => {
        resolve(response);
      }, options.chunkIntervalMs);
    });
  }
}

export function getCitationUrl(citation: string): string {
  return `${apiBaseUrl}/api/documents/${citation}`;
}

export async function deleteMessage(messageId: string, sessionId: string, userId: string, apiUrl?: string) {
  try {
    // Use the provided apiUrl or fall back to apiBaseUrl
    const baseUrl = apiUrl || apiBaseUrl;
    
    console.log(`Attempting to delete message ${messageId} from session ${sessionId} for user ${userId}`);
    console.log(`Using base URL: ${baseUrl}`);
    
    const url = `${baseUrl}/api/chats/${sessionId}/messages/${messageId}`;
    console.log(`DELETE request URL: ${url}`);
    
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        // Add userId in header
        'X-User-Id': userId,
      },
      // Send body with required data
      body: JSON.stringify({
        messageId: messageId,
        sessionId: sessionId,
        userId: userId
      })
    });
    
    console.log(`Response status: ${response.status}`);
    console.log(`Response statusText: ${response.statusText}`);
    
    if (!response.ok) {
      // Try to get more details from the response
      let errorDetails = '';
      try {
        const errorText = await response.text();
        errorDetails = errorText || 'No error details';
        console.log(`Error response body: ${errorDetails}`);
      } catch (e) {
        console.log('Could not read error response body');
      }
      
      throw new Error(`Failed to delete message: ${response.status} ${response.statusText}. Details: ${errorDetails}`);
    }
    
    const result = await response.json();
    console.log('Delete message response:', result);
    return result;
    
  } catch (error) {
    console.error('Error deleting message:', error);
    throw error;
  }
}