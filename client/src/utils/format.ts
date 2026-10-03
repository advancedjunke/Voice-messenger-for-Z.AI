// v1.0.11: общие форматтеры (используются в ChatArea и Sidebar)

/** «был(а) в сети: только что» / «был(а) в сети: N мин назад» / «N ч назад» /
 *  «вчера» / «D.MM» (для старых лет — с годом).
 *  NEW (v1.0.22) N10: относительный формат вместо абсолютного времени —
 *  в сайдбаре и шапке чата проще увидеть, насколько давно заходил собеседник. */
export function formatLastSeen(ts?: number): string {
  if (!ts || ts <= 0) return 'был(а) в сети давно';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'был(а) в сети: только что';

  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `был(а) в сети: ${mins} мин назад`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `был(а) в сети: ${hours} ч назад`;

  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'был(а) в сети: вчера';
  }

  // старые годы показываем с годом
  const sameYear = d.getFullYear() === now.getFullYear();
  const label = d.toLocaleDateString(
    'ru-RU',
    sameYear ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' }
  );
  return `был(а) в сети: ${label}`;
}

/** Заголовок-разделитель даты в чате: «Сегодня» / «Вчера» / «3 октября».
 *  NEW (v1.0.22) N4: явно ru-RU (раньше — локаль браузера). */
export function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    'ru-RU',
    sameYear
      ? { day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'long', year: 'numeric' }
  ).format(d);
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
