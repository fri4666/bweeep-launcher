import type { ReactNode } from "react";

/** Existing tools can live in the shared settings document without nested dialogs. */
export function PanelSurface({ embedded, className, label, onClose, children }: {
  embedded?: boolean;
  className: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (embedded) return <section className={`embeddedPanel ${className}`} aria-label={label}>{children}</section>;
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>
  );
}
