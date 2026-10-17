import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export function Button({ variant = 'default', className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={cx('fg-button', `fg-button-${variant}`, className)} {...rest} />;
}

// Icon-only button: the label is the accessible name and the default tooltip.
export function IconButton({ label, className, type = 'button', title, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type={type} aria-label={label} title={title ?? label} className={cx('fg-icon-button', className)} {...rest} />;
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export function StatusText({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('fg-status', `fg-tone-${tone}`)}>
      <span className="fg-dot" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function Banner({ tone = 'warning', children, actions }: { tone?: Tone; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx('fg-banner', `fg-tone-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="fg-banner-body">{children}</div>
      {actions ? <div className="fg-banner-actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fg-empty">
      <h3 className="fg-empty-title">{title}</h3>
      {children ? <p className="fg-empty-text">{children}</p> : null}
      {actions ? <div className="fg-empty-actions">{actions}</div> : null}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="fg-segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className="fg-segment"
          aria-pressed={option.value === value}
          disabled={option.disabled ?? false}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, children }: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="fg-field">
      <label className="fg-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="fg-field-error" role="alert">{error}</span> : hint ? <span className="fg-field-hint">{hint}</span> : null}
    </div>
  );
}
