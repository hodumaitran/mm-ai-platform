import { forwardApiRequest } from '@/server/api-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One allow-listed same-origin proxy to NestJS. Authentication is enforced by NestJS, not here.
export async function GET(request: Request): Promise<Response> {
  return forwardApiRequest(request);
}
export async function POST(request: Request): Promise<Response> {
  return forwardApiRequest(request);
}
export async function PATCH(request: Request): Promise<Response> {
  return forwardApiRequest(request);
}
export async function DELETE(request: Request): Promise<Response> {
  return forwardApiRequest(request);
}
