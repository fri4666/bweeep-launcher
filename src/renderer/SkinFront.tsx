import { useEffect, useRef } from "react";
import type { SkinModel } from "../shared/types.js";

/** Static full-body skin preview, shared by the profile and library cards. */
export function SkinFront({ dataUrl, model, className = "skinFront", label }: { dataUrl: string; model: SkinModel; className?: string; label?: string }) {
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
    return () => { image.onload = null; };
  }, [dataUrl, model]);

  return <canvas ref={canvasRef} className={className} width={64} height={128} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

