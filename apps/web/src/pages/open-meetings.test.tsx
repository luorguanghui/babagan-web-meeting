import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';
import { ClientWorkspacePage } from './client-workspace-page.js';
import { CreateMeetingPage } from './create-meeting-page.js';

const rooms = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
  slug: `meeting-${index}-abcdefghijklmnopqrstuv`, name, status: 'active',
  joinUrl: `https://untrusted.example/${index}`, requiresPassword: false, isFull: false
}));
const list = (meetings: object[]) => Response.json({ meetings, maxOpenMeetings: 3 });
const show = (page: 'create' | 'workspace') => render(<LanguageProvider initialLocale="en"><MemoryRouter>{page === 'create' ? <CreateMeetingPage /> : <ClientWorkspacePage />}</MemoryRouter></LanguageProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lists three separate workspace links and counts an unavailable room toward the capacity', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => list([{ ...rooms[0], unavailable: true }, rooms[1]!, rooms[2]!])));
  show('workspace');
  await screen.findByRole('heading', { name: 'Alpha' });
  expect(screen.getByText('3 / 3 meetings open')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
  expect(within(screen.getByRole('article', { name: 'Alpha' })).getByRole('button', { name: 'Temporarily unavailable' })).toBeDisabled();
  expect(screen.getAllByRole('link', { name: 'Open meeting' }).map(link => link.getAttribute('href'))).toEqual(rooms.slice(1).map(room => `/m/${room.slug}`));
  expect(screen.queryByText('Meeting full')).not.toBeInTheDocument();
});

it('ends only the selected room and gives every room card independent heading IDs', async () => {
  let open = [...rooms];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/v1/meetings/open') return list(open);
    if (path === `/api/v1/meetings/${rooms[1]!.slug}/admin-end` && init?.method === 'POST') {
      open = open.filter(room => room.slug !== rooms[1]!.slug);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  show('create');
  const beta = await screen.findByRole('region', { name: 'Current meeting Beta' });
  const headingIds = screen.getAllByRole('heading', { name: 'Current meeting' }).map(heading => heading.id);
  expect(new Set(headingIds).size).toBe(3);
  expect(screen.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
  expect(screen.getAllByRole('link', { name: 'Join current meeting' }).map(link => link.getAttribute('href'))).toEqual(rooms.map(room => `/m/${room.slug}`));
  fireEvent.change(within(beta).getByLabelText('Admin password to end meeting'), { target: { value: 'test-admin' } });
  fireEvent.click(within(beta).getByRole('button', { name: 'End current meeting' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current meeting Beta' })).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: 'Current meeting Alpha' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Current meeting Gamma' })).toBeVisible();
  expect(screen.getByText('2 / 3 meetings open')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create meeting' })).toBeEnabled();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([[`/api/v1/meetings/${rooms[1]!.slug}/admin-end`, expect.objectContaining({ body: JSON.stringify({ adminPassword: 'test-admin' }) })]]);
});

it('retains the last known full list if a later refresh fails', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(list(rooms)).mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  show('workspace');
  await screen.findByRole('heading', { name: 'Gamma' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh open meetings' }));
  await screen.findByRole('alert');
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
});

it('refreshes admission state after the server rejects a create that raced another room', async () => {
  let lookups = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/v1/meetings/open') return list(++lookups === 1 ? rooms.slice(0, 2) : rooms);
    return Response.json({ error: { code: 'MEETING_LIMIT_REACHED', message: 'Meeting capacity reached', correlationId: 'test' } }, { status: 409 });
  }));
  show('create');
  await screen.findByText('2 / 3 meetings open');
  fireEvent.change(screen.getByLabelText('Meeting name', { exact: true }), { target: { value: 'Fourth' } });
  fireEvent.change(screen.getByLabelText('Admin password', { exact: true }), { target: { value: 'test-admin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Three meetings are already open');
  await screen.findByText('3 / 3 meetings open');
  expect(screen.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
});

it('does not let a stale refresh resurrect a room after it was ended', async () => {
  let calls = 0;
  let resolveStale!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(null, { status: 204 });
    if (String(input) !== '/api/v1/meetings/open') throw new Error('Unexpected URL');
    calls++;
    if (calls === 2) return new Promise<Response>(resolve => { resolveStale = resolve; });
    return list(calls === 1 ? rooms : [rooms[0]!, rooms[2]!]);
  }));
  show('create');
  const beta = await screen.findByRole('region', { name: 'Current meeting Beta' });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(calls).toBe(2));
  fireEvent.change(within(beta).getByLabelText('Admin password to end meeting'), { target: { value: 'test-admin' } });
  fireEvent.click(within(beta).getByRole('button', { name: 'End current meeting' }));
  await screen.findByText('2 / 3 meetings open');
  resolveStale(list(rooms));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current meeting Beta' })).not.toBeInTheDocument());
});

it('keeps a newer invitation when an earlier room finishes ending later', async () => {
  let open = rooms.slice(0, 1);
  let creates = 0;
  let finishEnd!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/v1/meetings/open') return list(open);
    if (path === `/api/v1/meetings/${rooms[1]!.slug}/admin-end`) return new Promise<Response>(resolve => {
      finishEnd = () => { open = open.filter(room => room.slug !== rooms[1]!.slug); resolve(new Response(null, { status: 204 })); };
    });
    if (path === '/api/v1/meetings' && init?.method === 'POST') {
      const room = rooms[++creates]!; open = [...open, room];
      return Response.json({ slug: room.slug, joinUrl: `https://meet.example/m/${room.slug}` });
    }
    throw new Error('Unexpected request');
  }));
  show('create'); await screen.findByText('1 / 3 meetings open');
  const create = (name: string) => {
    fireEvent.change(screen.getByLabelText('Meeting name', { exact: true }), { target: { value: name } });
    fireEvent.change(screen.getByLabelText('Admin password', { exact: true }), { target: { value: 'test-admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
  };
  create('Beta');
  const beta = await screen.findByRole('region', { name: 'Current meeting Beta' });
  fireEvent.change(within(beta).getByLabelText('Admin password to end meeting'), { target: { value: 'test-admin' } });
  fireEvent.click(within(beta).getByRole('button', { name: 'End current meeting' }));
  await waitFor(() => expect(finishEnd).toBeTypeOf('function'));
  create('Gamma');
  await screen.findByText('3 / 3 meetings open');
  expect(screen.getByRole('link', { name: 'Enter as host' })).toHaveAttribute('href', `https://meet.example/m/${rooms[2]!.slug}`);
  finishEnd();
  await screen.findByText('2 / 3 meetings open');
  expect(screen.getByRole('link', { name: 'Enter as host' })).toHaveAttribute('href', `https://meet.example/m/${rooms[2]!.slug}`);
});
