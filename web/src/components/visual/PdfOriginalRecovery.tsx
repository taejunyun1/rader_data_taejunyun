import { useRef, useState } from "react";
import { extractPdfText, fileToBase64, renderPdfPreview } from "../../lib/pdf";

interface PdfOriginalRecoveryProps {
  sourceId: string;
  onRecovered: () => void | Promise<unknown>;
}

export default function PdfOriginalRecovery({ sourceId, onRecovered }: PdfOriginalRecoveryProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function recover(file: File) {
    if (file.size > 29_000_000) {
      setMessage("PDF는 29MB 이하만 다시 첨부할 수 있습니다.");
      return;
    }
    setBusy(true);
    setMessage("PDF 원본과 읽을 텍스트를 준비하는 중입니다.");
    try {
      const extracted = await extractPdfText(file);
      const hasText = extracted.text.replace(/\[page \d+\]|\s/g, "").length >= 20;
      const [originalBase64, previewBase64] = await Promise.all([fileToBase64(file), renderPdfPreview(file)]);
      const response = await fetch(`/api/inbox/${encodeURIComponent(sourceId)}/pdf-original`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          originalBase64,
          extractedText: hasText ? extracted.text : undefined,
          previewBase64,
          contentType: "application/pdf",
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "pdf_original_recovery_failed");
      setMessage("원본 PDF를 보존했습니다. 이제 시각 자료를 찾을 수 있습니다.");
      await onRecovered();
    } catch (error) {
      setMessage(error instanceof Error ? `복구하지 못했습니다: ${error.message}` : "PDF 원본을 복구하지 못했습니다.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="pdf-original-recovery" aria-label="PDF 원본 복구">
      <p className="reading-section__label">원본 필요</p>
      <strong>텍스트만 보존된 PDF입니다.</strong>
      <p>시각 자료를 찾으려면 같은 자료의 원본 PDF를 다시 첨부하세요. 기존 텍스트와 분석은 유지됩니다.</p>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        aria-label="원본 PDF 파일"
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void recover(file);
        }}
      />
      <button type="button" className="ui-button-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "원본 준비 중…" : "원본 PDF 다시 첨부"}
      </button>
      {message && <p className="pdf-original-recovery__message" role="status">{message}</p>}
    </section>
  );
}
