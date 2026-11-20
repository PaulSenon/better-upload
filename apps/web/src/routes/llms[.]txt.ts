import { createFileRoute } from '@tanstack/react-router';
import { serveLlms } from '@/lib/source';

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: ({ request }) => serveLlms(new URL(request.url).pathname),
    },
  },
});
