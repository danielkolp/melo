import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'sm' | 'md';
}

/** Square icon button. `label` is announced and shown as a tooltip. */
export function IconButton({ label, active, size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
        size === 'md' ? 'h-9 w-9' : 'h-7 w-7',
        active ? 'bg-tint text-fg' : 'text-fg-dim hover:bg-tint hover:text-fg',
        'disabled:pointer-events-none disabled:opacity-30',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

interface SegmentedProps<T extends string | number> {
  label: string;
  value: T | null;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange(value: T): void;
  className?: string;
}

/** A row of mutually exclusive options. `value` may be null when none applies. */
export function Segmented<T extends string | number>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('flex rounded-lg bg-well p-0.5', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-md px-2.5 py-1.5 text-[12.5px] transition-all duration-150',
            o.value === value ? 'bg-raised text-fg shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-fg-faint hover:text-fg-dim',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  accent?: string;
  onChange(value: number): void;
}

export function Slider({ label, value, min, max, step = 1, display, accent, onChange }: SliderProps) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] text-fg-dim">{label}</span>
        <span className="readout text-[11px] text-fg-faint">{display}</span>
      </span>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--fill': fill, ...(accent ? { '--accent': accent } : {}) } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  color?: string;
}

export function Switch({ label, checked, onChange, color }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150',
        checked ? 'bg-line-strong' : 'bg-well ring-1 ring-line',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] h-3 w-3 rounded-full shadow-sm transition-all duration-200',
          checked ? 'left-[17px]' : 'left-[3px] bg-fg-faint',
        )}
        style={checked ? { background: color ?? 'var(--color-fg)' } : undefined}
      />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="readout inline-flex min-w-[20px] items-center justify-center rounded border border-line-strong bg-well px-1 py-px text-[10px] text-fg-dim">
      {children}
    </kbd>
  );
}

/** A titled group inside a sidebar tab. Groups are separated by space, not rules. */
export function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex min-h-[20px] items-center justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Styled native select with a chevron. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full appearance-none rounded-lg bg-well py-2 pr-8 pl-3 text-[13px] text-fg transition-colors hover:bg-tint"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute top-1/2 right-3 h-3 w-3 -translate-y-1/2 text-fg-faint">
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}
