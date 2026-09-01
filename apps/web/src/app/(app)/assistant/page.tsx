'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, User } from 'lucide-react';
import type { AiChatResponseDto } from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const STARTERS = [
  'How much did I spend on food last month?',
  'What category wastes most of my money?',
  'Can I afford a vacation next summer?',
  'Predict my finances for the next 6 months.',
];

export default function AssistantPage() {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<string[]>(STARTERS);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post<AiChatResponseDto>('/ai/chat', { message, conversationId }),
    onSuccess: (response) => {
      setConversationId(response.conversationId);
      setSuggestions(response.suggestions);
      setMessages((current) => [
        ...current,
        { id: response.message.id, role: 'assistant', content: response.message.content },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] });
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Eco AI is unavailable right now. Your data is unaffected.',
      );
    },
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending) return;
    setError(null);
    // Optimistically append the user's turn: waiting for the round trip to
    // echo your own words back feels broken.
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', content: trimmed },
    ]);
    setInput('');
    send.mutate(trimmed);
  };

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col lg:min-h-[calc(100dvh-6rem)]">
      <PageHeader
        title="Eco AI"
        description="Ask anything about your own finances. Answers come from your records, not guesses."
      />

      <Card className="flex flex-1 flex-col overflow-hidden">
        <CardContent className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Bot className="size-6 text-primary" aria-hidden />
              </div>
              <p className="max-w-sm text-sm text-muted-foreground">
                Eco AI can see your income, spending, debts and forecast. It never invents a
                number — every figure comes from your own records.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'flex gap-3',
                  message.role === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                {message.role === 'assistant' ? (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Bot className="size-4 text-primary" aria-hidden />
                  </div>
                ) : null}
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                    message.role === 'user'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted text-foreground',
                  )}
                >
                  {message.content}
                </div>
                {message.role === 'user' ? (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                    <User className="size-4 text-secondary-foreground" aria-hidden />
                  </div>
                ) : null}
              </div>
            ))
          )}

          {send.isPending ? (
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Bot className="size-4 text-primary" aria-hidden />
              </div>
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                <span className="text-sm text-muted-foreground">Reading your figures…</span>
              </div>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div ref={endRef} />
        </CardContent>

        <div className="border-t p-3">
          {!send.isPending && suggestions.length > 0 ? (
            <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => submit(suggestion)}
                  className="shrink-0 rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(input);
            }}
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about your money…"
              aria-label="Message Eco AI"
              maxLength={2000}
              disabled={send.isPending}
            />
            <Button type="submit" size="icon" disabled={send.isPending || !input.trim()}>
              <Send className="size-4" aria-hidden />
              <span className="sr-only">Send</span>
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
