import { useEffect, useRef, useState } from 'react';
import { connectToComputer, linkError, type HistoryPage, type PhoneIdentity, type SavedComputer, type WorkPage } from './connection';

type Link = ReturnType<typeof connectToComputer>;

export function useComputer(computer: SavedComputer, identity: PhoneIdentity, phoneName: string, active: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [canSend, setCanSend] = useState(false);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [earlier, setEarlier] = useState<HistoryPage | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [work, setWork] = useState<WorkPage | null>(null);
  const [laterWork, setLaterWork] = useState<WorkPage | null>(null);
  const [workLoading, setWorkLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<{ link: Link; signal: AbortSignal; refresh: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!active) { setState('offline'); return; }
    const controller = new AbortController();
    const { signal } = controller;
    const link = connectToComputer(computer, identity, phoneName);
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    setState('connecting');
    setCanSend(false);
    setError('');
    setOlderLoading(false);
    setWorkLoading(false);
    setEarlier(null);
    setLaterWork(null);

    const refresh = async () => {
      if (signal.aborted || !connected || polling) return;
      polling = true;
      try {
        const [page, board] = await Promise.all([link.history(undefined, signal), link.work(undefined, signal)]);
        if (signal.aborted || !connected) return;
        setHistory(page);
        setWork(board);
      } catch (failure) {
        if (!signal.aborted && connected) setError(linkError(failure, 'The latest messages and work status could not be loaded.'));
      } finally { polling = false; }
    };
    const poll = async () => {
      await refresh();
      if (!signal.aborted && connected) timer = setTimeout(poll, 4500);
    };
    const off = link.onClose(failure => {
      if (signal.aborted || !connected) return;
      connected = false;
      current.current = null;
      clearTimeout(timer);
      setState('offline');
      setCanSend(false);
      setHistory(null);
      setEarlier(null);
      setWork(null);
      setLaterWork(null);
      setError(linkError(failure, 'Connection to the computer was lost.'));
    });
    void link.open(signal).then(info => {
      if (signal.aborted) return;
      connected = true;
      current.current = { link, signal, refresh };
      setState('online');
      setCanSend(info.canSend);
      void poll();
    }).catch(failure => {
      if (!signal.aborted) { setState('offline'); setError(linkError(failure, 'This computer is not connected. Check the computer and relay.')); }
    });
    return () => { current.current = null; controller.abort(); off(); clearTimeout(timer); void link.close(); };
  }, [active, attempt, computer, identity, phoneName]);

  async function loadOlder() {
    const connection = current.current;
    const before = (earlier ?? history)?.before;
    if (!connection || !before || olderLoading) return;
    setOlderLoading(true);
    try {
      const page = await connection.link.history(before, connection.signal);
      if (current.current !== connection) return;
      setEarlier(page);
      setError('');
    } catch (failure) {
      if (current.current === connection) setError(linkError(failure, 'Earlier messages could not be loaded.'));
    } finally { if (current.current === connection) setOlderLoading(false); }
  }

  async function loadMoreWork() {
    const connection = current.current;
    const after = (laterWork ?? work)?.after;
    if (!connection || !after || workLoading) return;
    setWorkLoading(true);
    try {
      const page = await connection.link.work(after, connection.signal);
      if (current.current !== connection) return;
      setLaterWork(page);
      setError('');
    } catch (failure) {
      if (current.current === connection) setError(linkError(failure, 'Work status could not be loaded.'));
    } finally { if (current.current === connection) setWorkLoading(false); }
  }

  const view = earlier ?? history;
  return { state, canSend, history: view, work: laterWork ?? work, before: view?.before, olderLoading, error, loadOlder,
    readingEarlier: earlier !== null, showLatest: () => setEarlier(null),
    workLoading, loadMoreWork, browsingWork: laterWork !== null, showFirstWork: () => setLaterWork(null),
    reconnect: () => setAttempt(value => value + 1), refresh: () => current.current?.refresh(),
    async send(text: string, commandId: string) {
      const connection = current.current;
      if (!connection) throw new Error('Reconnect before sending a message.');
      const receipt = await connection.link.send(text, commandId);
      if (current.current === connection) void connection.refresh();
      return receipt;
    },
  };
}
