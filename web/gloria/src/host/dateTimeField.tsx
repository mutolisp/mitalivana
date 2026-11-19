/**
 * Web stand-in for mobile/app/src/components/DateTimeField.tsx: the browser's
 * own date / time / datetime-local input (on phones, the system picker), in
 * the same field box. Same props; `onChange` fires once with the new epoch ms
 * and keeps the unedited half (as mobile does for 'date' and 'time').
 */
import { Ionicons } from '@expo/vector-icons';
import { isoDate, isoDateTime, isoTime } from '~/lib/datetime';
import { useThemeColors } from '~/theme/colors';

type Mode = 'date' | 'time' | 'datetime';
type Props = { value: number; onChange: (ts: number) => void; mode?: Mode; format?: (ts: number) => string };

const pad = (n: number) => String(n).padStart(2, '0');
function toInput(ts: number, mode: Mode): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return mode === 'date' ? date : mode === 'time' ? time : `${date}T${time}`;
}
function fromInput(v: string, base: number, mode: Mode): number | null {
  if (!v) return null;
  const out = new Date(base);
  if (mode === 'time') {
    const [h, m] = v.split(':').map(Number);
    out.setHours(h, m, 0, 0);
  } else if (mode === 'date') {
    const [y, mo, da] = v.split('-').map(Number);
    out.setFullYear(y, mo - 1, da);
  } else {
    const [date, time] = v.split('T');
    const [y, mo, da] = date.split('-').map(Number);
    const [h, m] = (time ?? '00:00').split(':').map(Number);
    out.setFullYear(y, mo - 1, da);
    out.setHours(h, m, 0, 0);
  }
  return Number.isFinite(out.getTime()) ? out.getTime() : null;
}

export function DateTimeField({ value, onChange, mode = 'datetime', format }: Props) {
  const c = useThemeColors();
  const shown = format ? format(value) : mode === 'date' ? isoDate(value) : mode === 'time' ? isoTime(value) : isoDateTime(value);
  return (
    <label className="relative flex cursor-pointer flex-row items-center rounded-lg border border-gray-300 bg-card px-3 py-2 dark:border-gray-600 dark:bg-gray-800">
      <Ionicons name={mode === 'date' ? 'calendar-outline' : 'time-outline'} size={16} color={c.accent} />
      <span className="ml-2 flex-1 text-base text-gray-900 dark:text-gray-100">{shown}</span>
      <Ionicons name="chevron-forward" size={16} color={c.ink3} />
      {/* The real control covers the box, invisible: tapping anywhere opens the picker. */}
      <input
        type={mode === 'datetime' ? 'datetime-local' : mode}
        value={toInput(value, mode)}
        onChange={(e) => {
          const ts = fromInput(e.target.value, value, mode);
          if (ts != null && ts !== value) onChange(ts);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label={shown}
      />
    </label>
  );
}
