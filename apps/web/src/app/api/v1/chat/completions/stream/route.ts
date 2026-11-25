import { forwardChatRequest } from '@/server/chat-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return forwardChatRequest(request, true);
}
