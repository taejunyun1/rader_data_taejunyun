export interface TopicRule {
  topic: string;
  keywords: string[];
}

const TOPIC_RULES: TopicRule[] = [
  { topic: "photography-theory", keywords: ["사진", "photography", "photograph", "카메라", "camera", "렌즈", "lens", "노출", "exposure", "인화", "print", "프린트", "필름", "film", "현상", "darkroom", "암실", "샤터", "셔터"] },
  { topic: "image-theory", keywords: ["이미지", "image", "표상", "representation", "재현", "index", "인덱스", "지표", "흔적", "trace", "아이콘", "icon", "기호", "sign"] },
  { topic: "machine-vision", keywords: ["machine vision", "computer vision", "머신비전", "컴퓨터비전", "object detection", "recognition", "인식", "cnn", "신경망", "neural", "deep learning", "딥러닝", "dataset", "데이터셋", "학습", "training"] },
  { topic: "computational-photography", keywords: ["computational photography", "계산사진", "nerf", "neural radiance", "3d reconstruction", "렌더링", "rendering", "synthetic image", "합성이미지", "생성", "generative", "diffusion", "gan"] },
  { topic: "network-transmission", keywords: ["네트워크", "network", "전송", "transmission", "송신", "transmitter", "신호", "signal", "패킷", "packet", "프로토콜", "protocol", "rf", "라디오", "radio", "통신"] },
  { topic: "body-embodiment", keywords: ["신체", "body", "몸", "embodiment", "감각", "sensation", "촉각", "haptic", "움직임", "movement", "제스처", "gesture", "센서", "sensor"] },
  { topic: "materiality", keywords: ["물질", "물질성", "materiality", "material", "오브제", "object", "매체", "medium", "표면", "surface", "질감", "texture", "현상"] },
  { topic: "archive-memory", keywords: ["아카이브", "archive", "기억", "memory", "기록", "record", "문서", "document", "역사", "history", "증거", "evidence", "수집", "collection"] },
  { topic: "media-art-history", keywords: ["미디어아트", "media art", "비디오아트", "video art", "설치", "installation", "현대미술", "contemporary art", "미술사", "art history", "전시", "exhibition", "작가", "artist", "큐레이션"] },
  { topic: "surveillance-power", keywords: ["감시", "surveillance", "권력", "power", "정치", "politics", "식민", "colonial", "탈식민", "postcolonial", "프로파일링", "privacy", "프라이버시", "윤리", "ethics"] },
  { topic: "data-epistemology", keywords: ["데이터", "data", "정보", "information", "지식", "knowledge", "계량", "measurement", "통계", "statistics", "메타데이터", "metadata", "알고리즘", "algorithm"] },
  { topic: "light-optics", keywords: ["빛", "light", "광학", "optics", "광원", "레이저", "laser", "발광", "led", "그림자", "shadow", "반사", "reflection", "굴절"] },
  { topic: "sound-audio", keywords: ["소리", "사운드", "sound", "음성", "audio", "진동", "파형", "tts", "speech"] },
  { topic: "craft-analog", keywords: ["수공", "아날로그", "analog", "공예", "craft", "습판", "wet plate", "콜로디온", "collodion", "시아노타입", "cyanotype", "플래티넘", "플라티넘", "은염", "silver gelatin", "zone system"] },
];

const MIN_TOPIC_SCORE = 2;

export function inferTopics(payload: { keywords?: string[]; important_fragments?: string[]; summary?: string }): string[] {
  const haystack: string[] = [];
  for (const kw of payload.keywords ?? []) haystack.push(kw.toLowerCase());
  for (const f of payload.important_fragments ?? []) haystack.push(f.toLowerCase());
  if (payload.summary) haystack.push(payload.summary.toLowerCase());

  const scores = new Map<string, number>();
  for (const rule of TOPIC_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      for (const hay of haystack) {
        if (hay.includes(kw)) {
          score += payload.keywords?.some((k) => k.toLowerCase() === kw) ? 2 : 1;
          break;
        }
      }
    }
    if (score >= MIN_TOPIC_SCORE) scores.set(rule.topic, score);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
}
