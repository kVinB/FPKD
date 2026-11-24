import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface FieldError {
  field: string;
  message: string;
}

export function ErrorSummary({
  errors,
  title = 'Check the highlighted fields',
}: {
  errors: FieldError[];
  title?: string;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [errors]);
  if (errors.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900"
    >
      <p className="font-semibold">{title}</p>
      <ul className="mt-2 list-disc pl-5">
        {errors.map((error) => (
          <li key={`${error.field}-${error.message}`}>
            <a
              href={`#field-${error.field}`}
              className="underline"
              onClick={(event) => {
                event.preventDefault();
                const target = document.getElementById(`field-${error.field}`);
                target?.focus();
                target?.scrollIntoView({ block: 'center' });
              }}
            >
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StatusMessage({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'error' | 'warning';
  children: ReactNode;
}): JSX.Element {
  const classes: Record<string, string> = {
    info: 'border-slate-300 bg-slate-50 text-slate-800',
    success: 'border-teal-300 bg-teal-50 text-teal-800',
    error: 'border-red-300 bg-red-50 text-red-900',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
  };
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border p-3 text-sm ${classes[tone]}`}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-6 text-slate-600">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600"
      />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="muted mt-2">{children}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const focusable = container?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !container) return;
      const items = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = originalOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="btn-secondary" onClick={onClose} aria-label="Close dialog">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

let zoneList: string[] | null = null;

export function timeZoneList(): string[] {
  if (zoneList) return zoneList;
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  let values: string[] = [];
  if (supported) {
    try {
      values = supported('timeZone');
    } catch {
      values = [];
    }
  }
  const fallbacks = [
    'UTC',
    'Europe/Dublin',
    'Europe/London',
    'Europe/Paris',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Australia/Sydney',
  ];
  zoneList = Array.from(new Set([...fallbacks, ...values])).sort();
  return zoneList;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function ZoneSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
}): JSX.Element {
  const zones = timeZoneList();
  return (
    <div>
      <input
        id={id}
        className="field-input"
        list={`${id}-zones`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
      />
      <datalist id={`${id}-zones`}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <p id={`${id}-hint`} className="muted mt-1">
        IANA time zone, e.g. Europe/Dublin.
      </p>
    </div>
  );
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 639px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const listener = () => setIsMobile(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return isMobile;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
