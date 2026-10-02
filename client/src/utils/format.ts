// v1.0.11: общие форматтеры (используются в ChatArea и Sidebar)

/** «был(а) в сети в 14:32» / «вчера в 09:05» / «3 окт» */
export function formatLastSeen(ts?: number): string {
  if (!ts || ts <= 0) return 'был(а) в сети давно';
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) {
    return `был(а) в сети в ${time}`;
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return `был(а) в сети вчера в ${time}`;
  }
  return `был(а) в сети ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

/** Заголовок-разделитель даты в чате: «Сегодня» / «Вчера» / «3 октября» */
export function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    [],
    sameYear
      ? { day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'long', year: 'numeric' }
  );
}

/** Разбор версии «1.2.3» / «v1.2.3-rc» → [1,2,3] или null */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** v1.0.11: строгое сравнение версий — true только если a НОВЕЕ b.
 *  Раньше клиент показывал бейдж обновления для ЛЮБОЙ отличающейся версии,
 *  включая более старые (например, тестовый релиз 9.9.9-test после E2E). */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}
