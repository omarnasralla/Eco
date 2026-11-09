'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ListTodo, Loader2, Plus, Trash2 } from 'lucide-react';
import type { TaskDto } from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { useMoneyFormat } from '@/lib/auth-provider';
import { cn, formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Things to do: a title and, if it has one, a date. The list orders itself —
 * overdue, today, by date, then undated oldest first — so there is nothing to
 * prioritise by hand. The first three open ones are what the briefing names.
 */
export function TasksCard() {
  const { locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<TaskDto[]>('/tasks') });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['briefing'] });
  };

  const add = useMutation({
    mutationFn: () => api.post('/tasks', { title: title.trim(), dueOn: dueOn || null }),
    onMutate: () => setError(null),
    onSuccess: () => {
      setTitle('');
      setDueOn('');
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add that.'),
  });

  const toggle = useMutation({
    mutationFn: (task: TaskDto) =>
      api.post(`/tasks/${task.id}/${task.status === 'DONE' ? 'undo' : 'done'}`),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/tasks/${id}`),
    onSuccess: refresh,
  });

  const open = tasks.data?.filter((t) => t.status !== 'DONE') ?? [];
  const done = tasks.data?.filter((t) => t.status === 'DONE') ?? [];

  const row = (task: TaskDto) => (
    <li key={task.id} className="flex items-center gap-2 py-2">
      <button
        type="button"
        onClick={() => toggle.mutate(task)}
        aria-label={task.status === 'DONE' ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-primary"
      >
        {task.status === 'DONE' ? (
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
        ) : (
          <Circle className="size-5" aria-hidden />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', task.status === 'DONE' && 'text-muted-foreground line-through')}>
          {task.title}
        </p>
        {task.dueOn && task.status !== 'DONE' ? (
          <p
            className={cn(
              'text-xs',
              task.status === 'OVERDUE' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {task.status === 'OVERDUE'
              ? `Overdue · ${formatDate(task.dueOn, locale)}`
              : task.status === 'TODAY'
                ? 'Today'
                : formatDate(task.dueOn, locale)}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Delete "${task.title}"`}
        onClick={() => remove.mutate(task.id)}
        disabled={remove.isPending}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </li>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="size-4 text-muted-foreground" aria-hidden />
          To do
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) add.mutate();
          }}
        >
          <Input
            className="min-w-0 flex-1 basis-48"
            placeholder="Add a task"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="New task"
          />
          <Input
            type="date"
            className="w-40"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            aria-label="Due date (optional)"
          />
          <Button type="submit" variant="outline" disabled={!title.trim() || add.isPending}>
            {add.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            Add
          </Button>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {tasks.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to do. Enjoy it.</p>
        ) : (
          <ul className="divide-y">{open.map(row)}</ul>
        )}

        {done.length > 0 ? (
          <div>
            <Button size="sm" variant="ghost" className="px-0" onClick={() => setShowDone((v) => !v)}>
              {showDone ? 'Hide' : 'Show'} done this week ({done.length})
            </Button>
            {showDone ? <ul className="divide-y">{done.map(row)}</ul> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
