import type { ReactNode } from "react";
import { useId, useState } from "react";

export default function DistillDetailDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return <div className={`distill-detail-disclosure${open ? " is-open" : ""}`}>
    <button
      className="distill-detail-disclosure__toggle"
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      onClick={() => setOpen((current) => !current)}
    >
      {open ? "근거와 맥락 닫기" : "근거와 맥락 보기"}
    </button>
    {open && <div id={contentId} className="distill-detail-disclosure__content">{children}</div>}
  </div>;
}
