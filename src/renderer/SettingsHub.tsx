import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

/** One scrollable document; navigation jumps to sections without replacing them. */
export function SettingsHub({ sections, version, notice, error, onClose }: {
  sections: SettingsSection[];
  version: string;
  notice: string;
  error: string;
  onClose: () => void;
}) {
  const [active, setActive] = useState(sections[0]?.id ?? "account");
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const threshold = scroll.getBoundingClientRect().top + 100;
      const nodes = [...scroll.querySelectorAll<HTMLElement>("[data-settings-section]")];
      const current = nodes.filter((node) => node.getBoundingClientRect().top <= threshold).at(-1) ?? nodes[0];
      if (current) setActive(current.dataset.settingsSection!);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function navigate(id: string) {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
    node?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    setActive(id);
  }

  return (
    <div className="modalBackdrop settingsBackdrop" onClick={onClose}>
      <section ref={dialogRef} className="settingsHub" role="dialog" aria-modal="true" aria-label="프로필 및 설정"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']") ?? [])]
            .filter((node) => node.getClientRects().length > 0);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <aside className="settingsNavigation">
          <div className="settingsNavigationHeading"><span>나의 런처</span><h2>프로필 및 설정</h2></div>
          <nav aria-label="설정 메뉴">
            {sections.map((section) => (
              <button key={section.id} aria-current={active === section.id ? "location" : undefined} onClick={() => navigate(section.id)}>
                {section.icon}<span>{section.label}</span>
              </button>
            ))}
          </nav>
          <small className="settingsVersion">런처 {version ? `v${version}` : ""}</small>
        </aside>
        <div className="settingsDocument">
          <header className="settingsDocumentHeader">
            {error ? <span className="settingsError" role="alert">{error}</span>
              : notice ? <span className="settingsSuccess" role="status">{notice}</span>
              : <span>메뉴를 선택하거나 스크롤로 이동하세요</span>}
            <div id="settings-feedback" />
            <button ref={closeRef} className="closeButton" onClick={onClose}>닫기</button>
          </header>
          <div ref={scrollRef} className="settingsScroll">
            {sections.map((section) => <div key={section.id} data-settings-section={section.id} className="settingsSection">{section.content}</div>)}
          </div>
        </div>
      </section>
    </div>
  );
}
