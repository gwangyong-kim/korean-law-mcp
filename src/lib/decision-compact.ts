/**
 * Decision Compact — 판례/헌재/행심 응답 토큰 최적화 유틸
 *
 * B. compactBody: 본문("이유"/"전문")을 "앞 800자 + 중략 + 뒤 400자"로 계단식 축약.
 *    판시사항/판결요지/주문은 이미 별도 필드로 분리 반환되므로 본문에만 적용.
 *    문장 경계(마침표·판례 특유 종결어미)를 존중하여 중간 절단 방지.
 *
 * C. densifyLawRefs / densifyPrecedentRefs: 참조조문·참조판례의 서지 잉여 제거.
 *    괄호 안 조문명, "선고"/"판결" 군더더기, 날짜 공백 압축. 구조 유지 + 압축.
 *
 * 안전성: 모든 함수는 매칭 실패 / 빈 입력 / 짧은 입력 시 **원본 그대로 반환**.
 */

export interface CompactOptions {
  /** true 시 축약 비활성 → 원본 반환 */
  full?: boolean
  /** 앞쪽 보존 길이 (기본 800자) */
  headSize?: number
  /** 뒤쪽 보존 길이 (기본 400자) */
  tailSize?: number
  /** head+tail+minSave 이하면 축약 안 함 (기본 500자) */
  minSave?: number
}

/**
 * 본문 계단식 축약
 * - 앞 800자 + 중략 마커 + 뒤 400자
 * - 문장 경계 가드: 마침표/판례 종결어미/빈 줄에서 끊기
 * - head 기준 50% 이상 위치에 경계 없으면 원시 슬라이스 사용 (fallback)
 */
export function compactBody(text: string, opts: CompactOptions = {}): string {
  if (opts.full || !text) return text

  const HEAD = opts.headSize ?? 800
  const TAIL = opts.tailSize ?? 400
  const MIN_SAVE = opts.minSave ?? 500

  // 짧으면 축약 이득 없음 → 원본
  if (text.length <= HEAD + TAIL + MIN_SAVE) return text

  // HEAD — 앞에서 HEAD자까지 중 문장 끝에서 자르기
  const headRaw = text.slice(0, HEAD)
  const headBoundaries = [
    headRaw.lastIndexOf("다.\n"),
    headRaw.lastIndexOf("라.\n"),
    headRaw.lastIndexOf("다. "),
    headRaw.lastIndexOf("라. "),
    headRaw.lastIndexOf(".\n\n"),
    headRaw.lastIndexOf("\n\n"),
    headRaw.lastIndexOf(". "),
  ]
  const headCutCandidate = Math.max(...headBoundaries)
  const headCut = headCutCandidate > HEAD * 0.5 ? headCutCandidate + 2 : HEAD
  const head = text.slice(0, headCut).trimEnd()

  // TAIL — 뒤에서 TAIL자 범위 중 문장 시작에서 자르기
  const tailStart = text.length - TAIL
  const tailRaw = text.slice(tailStart)
  const tailBoundaryIdx = [
    tailRaw.indexOf("\n\n"),
    tailRaw.indexOf(". "),
    tailRaw.indexOf("다.\n"),
    tailRaw.indexOf("다. "),
  ]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0]

  const tailFrom =
    tailBoundaryIdx !== undefined && tailBoundaryIdx < TAIL * 0.5
      ? tailStart + tailBoundaryIdx + 2
      : tailStart
  const tail = text.slice(tailFrom).trimStart()

  const omitted = text.length - head.length - tail.length
  if (omitted < MIN_SAVE) return text // 실질 절감 미달 시 원본

  return `${head}\n\n⋯ 중략 ${omitted.toLocaleString()}자 (full=true로 전문 조회) ⋯\n\n${tail}`
}

/**
 * 참조조문 densify
 *
 * 압축 전략:
 *   1) 조문명 괄호 설명 제거: "제390조(채무불이행과 손해배상)" → "제390조"
 *   2) 연속 공백/구분자 정리
 *
 * 조문명 괄호는 평균 15~30자 × 참조조문 5~10개 = 150~300자 절감 (40%).
 * 법령명 자체는 건드리지 않음 — LLM이 후속 도구 호출 시 파싱 필요.
 */
export function densifyLawRefs(text: string): string {
  if (!text) return text
  const original = text

  // 1) 조문 뒤 괄호 설명 제거
  //    "제390조(채무불이행과 손해배상)" → "제390조"
  //    "제1항(적용범위)" → "제1항"
  //    길이 3~40자 괄호만 타겟 (짧은 건 의미 있을 수 있음)
  let compact = text.replace(/(제\d+조(?:의\d+)?|제\d+항|제\d+호)\s*\([^)]{3,40}\)/g, "$1")

  // 2) 공백/구분자 정리
  compact = compact
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  // 실질 절감 없으면 원본
  if (compact.length >= original.length * 0.95) return original
  return compact
}

/**
 * 참조판례 densify
 *
 * 압축 전략:
 *   1) "선고" 생략: "대법원 2020. 3. 26. 선고 2018두56077 판결" → "대법원 2020.3.26. 2018두56077"
 *   2) 날짜 공백 압축: "2020. 3. 26." → "2020.3.26."
 *   3) "판결" 접미어 제거
 *   4) 구분자 정리
 */
export function densifyPrecedentRefs(text: string): string {
  if (!text) return text
  const original = text

  let compact = text
    // "선고" 앞뒤 공백 포함 제거
    .replace(/\s*선고\s*/g, " ")
    // "판결" 접미어 (공백 포함) 제거
    .replace(/\s*판결(?=[\s,/;]|$)/g, "")
    // 날짜 공백 압축: "2020. 3. 26." → "2020.3.26."
    .replace(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./g, "$1.$2.$3.")
    // "[동지] ", "[공보 생략]" 같은 부가표기 제거
    .replace(/\s*\[[^\]]{2,15}\]\s*/g, " ")
    // 연속 공백
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim()

  if (compact.length >= original.length * 0.95) return original
  return compact
}

/**
 * 본문에서 판시사항/판결요지가 반복 등장하면 제거
 *
 * 법제처 API 판례 응답은 `판시사항`, `판결요지`가 별도 필드로 나오지만
 * `판례내용`(전문) 앞쪽에 같은 내용이 반복되는 케이스가 많다.
 * 이미 상단에 렌더된 부분을 본문에서 제거하여 LLM 중복 소비 방지.
 */
export function stripRepeatedSummary(
  body: string,
  summaries: Array<string | undefined>
): string {
  if (!body) return body
  let result = body
  for (const s of summaries) {
    if (!s || s.length < 20) continue
    const head = s.trim().slice(0, Math.min(80, s.length))
    if (head.length < 20) continue
    // 본문 앞 25% 안에서 동일 구간 탐지
    const zone = result.slice(0, Math.floor(result.length * 0.25))
    const idx = zone.indexOf(head)
    if (idx >= 0) {
      // 매칭 구간 ~ 요약 전체 길이만큼 제거 (±20% tolerance)
      const end = Math.min(idx + s.length + 50, result.length)
      result = result.slice(0, idx) + result.slice(end)
    }
  }
  return result
}
