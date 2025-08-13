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

// Substitua ou adicione esta função no arquivo api.js:

export async function deleteMessage(messageId: string, sessionId: string, userId: string, apiUrl?: string): Promise<any> {
  const baseUrl = apiUrl || import.meta.env.VITE_API_URL || '';
  const url = `${baseUrl}/api/chats/${sessionId}/messages/${messageId}`;
  
  console.log('=== API DELETE MESSAGE ===');
  console.log('URL:', url);
  console.log('messageId:', messageId);
  console.log('sessionId:', sessionId);
  console.log('userId:', userId);
  
  try {
    const requestOptions = {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      // Incluir userId no body como backup
      body: JSON.stringify({ 
        messageId, 
        sessionId, 
        userId 
      }),
    };
    
    console.log('Request options:', JSON.stringify(requestOptions, null, 2));
    
    const response = await fetch(url, requestOptions);
    
    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response text:', errorText);
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }
    
    const result = await response.json();
    console.log('Delete response:', result);
    
    return result;
    
  } catch (error) {
    console.error('Delete message API error:', error);
    throw error;
  }
}