import { useEffect, useState } from "react";

interface VisualPreviewImageProps {
  src: string;
  alt: string;
  loading?: "eager" | "lazy";
}

export default function VisualPreviewImage({ src, alt, loading }: VisualPreviewImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <div className="visual-preview-fallback" role="status" aria-label="이미지 미리보기 상태">
        <span aria-hidden="true">◌</span>
        <span>미리보기를 불러오지 못했습니다.</span>
      </div>
    );
  }

  return <img src={src} alt={alt} loading={loading} onError={() => setFailed(true)} />;
}
