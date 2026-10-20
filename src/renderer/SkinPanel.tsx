import { useEffect, useRef, useState } from "react";
import { SkinViewer, WalkingAnimation } from "skinview3d";
import type { SkinModel, SkinState } from "../shared/types.js";

type Choice =
  | { kind: "library"; id: string; name: string; model: SkinModel; dataUrl: string }
  | { kind: "default"; name: string; model: SkinModel; dataUrl: string };

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

/** Rotatable 3D model; drag to turn it around. */
function SkinPreview({ dataUrl, model }: { dataUrl: string | null; model: SkinModel }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new SkinViewer({ canvas: canvasRef.current, width: 220, height: 290 });
    viewer.controls.enablePan = false;
    viewer.controls.enableZoom = false;
    viewer.animation = new WalkingAnimation();
    viewer.animation.speed = 0.6;
    viewer.zoom = 0.85;
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (dataUrl) void viewer.loadSkin(dataUrl, { model });
    else viewer.resetSkin();
  }, [dataUrl, model]);

  return <canvas ref={canvasRef} className="skinCanvas" aria-label="스킨 3D 미리보기. 끌어서 돌려 볼 수 있어요." />;
}

/** Flat front view drawn from the skin file, for library cards. */
function SkinFront({ dataUrl, model }: { dataUrl: string; model: SkinModel }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const context = canvasRef.current?.getContext("2d");
      if (!context) return;
      const legacy = image.height === 32;
      const arm = model === "slim" ? 3 : 4;
      context.clearRect(0, 0, 64, 128);
      context.imageSmoothingEnabled = false;
      const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, mirror = false) => {
        context.save();
        if (mirror) {
          context.translate((dx + w) * 4, dy * 4);
          context.scale(-1, 1);
          context.drawImage(image, sx, sy, w, h, 0, 0, w * 4, h * 4);
        } else {
          context.drawImage(image, sx, sy, w, h, dx * 4, dy * 4, w * 4, h * 4);
        }
        context.restore();
      };
      const x = 4;
      part(8, 8, 8, 8, x, 0);
      part(20, 20, 8, 12, x, 8);
      part(44, 20, arm, 12, x - arm, 8);
      if (legacy) part(44, 20, arm, 12, x + 8, 8, true); else part(36, 52, arm, 12, x + 8, 8);
      part(4, 20, 4, 12, x, 20);
      if (legacy) part(4, 20, 4, 12, x + 4, 20, true); else part(20, 52, 4, 12, x + 4, 20);
      // Second layer: hat, jacket, sleeves and trousers exist only in 64x64 skins.
      part(40, 8, 8, 8, x, 0);
      if (!legacy) {
        part(20, 36, 8, 12, x, 8);
        part(44, 36, arm, 12, x - arm, 8);
        part(52, 52, arm, 12, x + 8, 8);
        part(4, 36, 4, 12, x, 20);
        part(4, 52, 4, 12, x + 4, 20);
      }
    };
    image.src = dataUrl;
  }, [dataUrl, model]);

  return <canvas ref={canvasRef} className="skinFront" width={64} height={128} aria-hidden="true" />;
}

export function SkinPanel({ instanceRoot, serverShowsSkins, onClose }: {
  instanceRoot: string;
  serverShowsSkins: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<SkinState | null>(null);
  const [selected, setSelected] = useState<Choice | null>(null);
  const [model, setModel] = useState<SkinModel>("default");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  async function run(action: () => Promise<SkinState>, fallback: string, done?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const next = await action();
      setState(next);
      if (done) setNotice({ text: done, error: false });
      return next;
    } catch (error) {
      setNotice({ text: message(error, fallback), error: true });
      return null;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(() => window.bweeep.skinState(instanceRoot), "스킨 정보를 불러오지 못했어요.").then((next) => {
      if (next?.current) setModel(next.current.model);
      if (next?.serverError) setNotice({ text: `적용된 스킨을 확인하지 못했어요 (${next.serverError})`, error: true });
    });
  }, [instanceRoot]);

  const current = state?.current ?? null;
  const previewUrl = selected?.dataUrl ?? current?.dataUrl ?? state?.defaults[0]?.dataUrl ?? null;
  const isCurrent = (choice: Choice) => choice.kind === "library" && choice.id === current?.id;
  const selectedIsCurrent = !selected || isCurrent(selected);
  const modelChanged = selectedIsCurrent && current !== null && model !== current.model;

  function choose(choice: Choice) {
    setSelected(isCurrent(choice) ? null : choice);
    setModel(isCurrent(choice) && current ? current.model : choice.model);
    setNotice(null);
  }

  async function apply() {
    const target = selected;
    const done = "스킨 적용됨 · 다음 접속부터";
    if (!target && current) {
      await run(() => window.bweeep.applySkin(instanceRoot, current.id, model), "스킨을 적용하지 못했어요.", done);
    } else if (target?.kind === "library") {
      if (await run(() => window.bweeep.applySkin(instanceRoot, target.id, model), "스킨을 적용하지 못했어요.", done)) setSelected(null);
    } else if (target?.kind === "default") {
      if (await run(() => window.bweeep.applyDefaultSkin(instanceRoot, target.name), "스킨을 적용하지 못했어요.", done)) setSelected(null);
    }
  }

  async function addSkin() {
    const before = new Set(state?.library.map((entry) => entry.id));
    const next = await run(() => window.bweeep.addSkin(instanceRoot), "스킨 파일을 추가하지 못했어요.");
    const added = next?.library.find((entry) => !before.has(entry.id));
    if (added) choose({ kind: "library", ...added });
  }

  async function remove(id: string) {
    if (selected?.kind === "library" && selected.id === id) setSelected(null);
    await run(() => window.bweeep.removeSkin(instanceRoot, id), "스킨을 지우지 못했어요.");
  }

  const canApply = !busy && (selected !== null || modelChanged);

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className="modal skinModal" role="dialog" aria-modal="true" aria-label="스킨" onClick={(event) => event.stopPropagation()}>
        <header className="modalHeader">
          <div>
            <p className="eyebrow">스킨</p>
            <h2>내 스킨</h2>
          </div>
          <button className="closeButton" onClick={onClose}>닫기</button>
        </header>
        <div className="modalBody skinBody">
          {notice && <p className={`noticeBar${notice.error ? "" : " isInfo"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
          {!serverShowsSkins && (
            <p className="noticeBar isInfo">이 서버는 아직 붸에엡 스킨을 안 써요.</p>
          )}
          <div className="skinLayout">
            <section className="skinStage">
              <h3>{selected ? `미리보기 · ${selected.name}` : "현재 스킨"}</h3>
              {previewUrl ? <SkinPreview dataUrl={previewUrl} model={model} /> : (
                <div className="skinEmpty">기본 스킨 사용 중</div>
              )}
              <p className="mutedText">끌어서 돌려 볼 수 있어요.</p>
              <div className="segmented" role="radiogroup" aria-label="팔 모양">
                {(["default", "slim"] as const).map((option) => (
                  <button key={option} role="radio" aria-checked={model === option} className={model === option ? "active" : ""} disabled={busy} onClick={() => setModel(option)}>
                    {option === "default" ? "기본 팔" : "얇은 팔"}
                  </button>
                ))}
              </div>
              <div className="skinStageActions">
                {(selected || current) && (
                  <button className="primaryButton" disabled={!canApply} onClick={() => void apply()}>
                    {busy ? "저장 중…" : selectedIsCurrent ? "팔 모양 저장" : "이 스킨 적용"}
                  </button>
                )}
                {current && (
                  <button className="textButton" disabled={busy} onClick={() => void run(() => window.bweeep.resetSkin(instanceRoot), "기본 스킨으로 되돌리지 못했어요.", "기본 스킨으로 바뀜")}>
                    기본 스킨으로
                  </button>
                )}
              </div>
            </section>
            <section className="skinLibrary">
              <h3>라이브러리</h3>
              <div className="skinGrid">
                <button className="skinCard skinAddCard" disabled={busy} onClick={() => void addSkin()}>
                  <span className="skinAddIcon" aria-hidden="true">+</span>
                  <span>새 스킨</span>
                  <small>64×64 PNG</small>
                </button>
                {state?.library.map((entry) => {
                  const choice: Choice = { kind: "library", ...entry };
                  const active = selected?.kind === "library" ? selected.id === entry.id : entry.id === current?.id;
                  return (
                    <div className={`skinCard${active ? " active" : ""}`} key={entry.id}>
                      <button className="skinCardPick" onClick={() => choose(choice)} aria-pressed={active}>
                        <SkinFront dataUrl={entry.dataUrl} model={entry.model} />
                        <span title={entry.name}>{entry.name}</span>
                        {entry.id === current?.id && <small className="skinInUse">사용 중</small>}
                      </button>
                      {entry.id !== current?.id && (
                        <button className="skinRemove" aria-label={`${entry.name} 삭제`} disabled={busy} onClick={() => void remove(entry.id)}>×</button>
                      )}
                    </div>
                  );
                })}
                {state?.defaults.map((skin) => {
                  const active = selected?.kind === "default" && selected.name === skin.name;
                  return (
                    <div className={`skinCard${active ? " active" : ""}`} key={skin.name}>
                      <button className="skinCardPick" onClick={() => choose({ kind: "default", ...skin })} aria-pressed={active}>
                        <SkinFront dataUrl={skin.dataUrl} model={skin.model} />
                        <span>{skin.name}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
