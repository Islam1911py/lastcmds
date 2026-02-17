import type { Prisma } from "@prisma/client"

export const EXPENSE_SOURCE_TYPES = [
  "TECHNICIAN_WORK",
  "STAFF_WORK",
  "ELECTRICITY",
  "OTHER"
] as const

export type ExpenseSourceType = (typeof EXPENSE_SOURCE_TYPES)[number]

export const SOURCE_TYPE_KEYWORDS: Array<{ type: ExpenseSourceType; keywords: string[] }> = [
  {
    type: "TECHNICIAN_WORK",
    keywords: ["technician", "tech", "صيانة", "صيانه", "فني", "الفني", "فنين"]
  },
  {
    type: "STAFF_WORK",
    keywords: ["staff", "عامل", "عمالة", "عماله", "موظف", "موظفين"]
  },
  {
    type: "ELECTRICITY",
    keywords: ["electricity", "electric", "كهرباء", "كهربا", "الكهرباء", "شحن", "شحنه", "شحنات"]
  },
  {
    type: "OTHER",
    keywords: [
      "other",
      "misc",
      "general",
      "زينة",
      "زينه",
      "الزينه",
      "ديكور",
      "ديكورات",
      "trash",
      "garbage",
      "waste",
      "bin",
      "bins",
      "صندوق",
      "صناديق",
      "زبالة",
      "زباله",
      "قمامة",
      "قمامه",
      "حاوية",
      "حاويات"
    ]
  }
]

export type SearchKeywordGroup = {
  label: string
  terms: string[]
}

export const SEARCH_KEYWORD_GROUPS: SearchKeywordGroup[] = [
  {
    label: "DECORATION",
    terms: [
      "زينة",
      "زينه",
      "الزينه",
      "ديكور",
      "ديكورات",
      "decor",
      "decoration",
      "ornament",
      "ornaments"
    ]
  },
  {
    label: "WASTE_BINS",
    terms: [
      "صندوق",
      "صناديق",
      "صندوق زبالة",
      "صناديق زبالة",
      "زبالة",
      "زباله",
      "قمامة",
      "قمامه",
      "حاوية",
      "حاويات",
      "سلة",
      "سلل",
      "trash",
      "trashcan",
      "trash can",
      "garbage",
      "garbage can",
      "garbage bin",
      "bin",
      "bins",
      "waste",
      "waste bin",
      "dumpster"
    ]
  }
]

export const SEARCH_STOP_WORDS = new Set(
  [
    "ايه",
    "اي",
    "ايش",
    "هو",
    "هي",
    "هم",
    "هن",
    "احنا",
    "انا",
    "انت",
    "انتي",
    "انتو",
    "ال",
    "على",
    "عن",
    "في",
    "من",
    "ما",
    "ايوه",
    "لا",
    "مش",
    "كام",
    "كم",
    "ليه",
    "اللي",
    "was",
    "were",
    "what",
    "did",
    "how",
    "much",
    "many",
    "the",
    "a",
    "an",
    "and",
    "or",
    "we",
    "us",
    "for",
    "on",
    "to",
    "of"
  ]
)

export function normalizeArabic(text: string) {
  return text
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
}

export function normalizeSearchText(text: string) {
  if (!text) {
    return ""
  }

  const lower = text.toLowerCase().trim()
  const withoutPunctuation = lower.replace(/[^\p{L}\p{N}\s]+/gu, " ")
  const normalizedArabic = normalizeArabic(withoutPunctuation)

  return normalizedArabic.replace(/\s+/g, " ").trim()
}

const SEARCH_KEYWORD_GROUP_LOOKUP = new Map<string, SearchKeywordGroup>()

for (const group of SEARCH_KEYWORD_GROUPS) {
  for (const term of group.terms) {
    const normalized = normalizeSearchText(term)
    if (normalized && !SEARCH_KEYWORD_GROUP_LOOKUP.has(normalized)) {
      SEARCH_KEYWORD_GROUP_LOOKUP.set(normalized, group)
    }
  }
}

export function expandSearchToken(token: string) {
  const normalized = normalizeSearchText(token)
  if (!normalized) {
    return [] as string[]
  }

  const expansions = new Set<string>()
  const group = SEARCH_KEYWORD_GROUP_LOOKUP.get(normalized)

  if (group) {
    for (const term of group.terms) {
      const normalizedTerm = normalizeSearchText(term)
      if (normalizedTerm) {
        expansions.add(term)
        expansions.add(normalizedTerm)
      }
    }
  }

  expansions.add(token)
  expansions.add(normalized)

  return Array.from(expansions).filter(Boolean)
}

type DescriptionFilter = {
  description?: {
    contains: string
    mode: "insensitive"
  }
  OR?: DescriptionFilter[]
  AND?: DescriptionFilter[]
}

export function buildDescriptionFilter(tokens: string[]): DescriptionFilter | null {
  const clauses: DescriptionFilter[] = []

  for (const token of tokens) {
    const expansions = expandSearchToken(token)
    if (expansions.length === 0) {
      continue
    }

    const expansionClauses = Array.from(new Set(expansions)).map((phrase) => ({
      description: {
        contains: phrase,
        mode: "insensitive" as const
      }
    }))

    if (expansionClauses.length === 1) {
      clauses.push(expansionClauses[0])
    } else {
      clauses.push({ OR: expansionClauses })
    }
  }

  if (clauses.length === 0) {
    return null
  }

  if (clauses.length === 1) {
    return clauses[0]
  }

  return { AND: clauses }
}

export type ExpenseSearchAnalysis = {
  normalizedSearch: string | null
  matchedSourceTypes: Set<ExpenseSourceType>
  descriptionTokens: string[]
  descriptionSummary: string | null
  tokenVariants: Map<string, string[]>
}

export function analyzeExpenseSearch(rawSearchTerm: string): ExpenseSearchAnalysis {
  const normalizedSearch = normalizeSearchText(rawSearchTerm)
  const matchedSourceTypes = new Set<ExpenseSourceType>()
  const descriptionTokens: string[] = []
  const tokenVariants = new Map<string, string[]>()

  if (!normalizedSearch) {
    return {
      normalizedSearch: null,
      matchedSourceTypes,
      descriptionTokens,
      descriptionSummary: null,
      tokenVariants
    }
  }

  const tokens = normalizedSearch.split(" ").filter(Boolean)

  for (const rawToken of rawSearchTerm
    .split(/\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean)) {
    const normalized = normalizeSearchText(rawToken)
    if (!normalized) {
      continue
    }

    const variants = tokenVariants.get(normalized)
    if (variants) {
      variants.push(rawToken)
    } else {
      tokenVariants.set(normalized, [rawToken])
    }
  }

  const remainingTokens: string[] = []
  const seenTokens = new Set<string>()

  for (const token of tokens) {
    if (!token || SEARCH_STOP_WORDS.has(token)) {
      continue
    }

    const bareToken = token.startsWith("ال") && token.length > 2 ? token.slice(2) : token
    const matchedEntry = SOURCE_TYPE_KEYWORDS.find((entry) =>
      entry.keywords.some((keyword) => {
        const normalizedKeyword = normalizeSearchText(keyword)
        if (!normalizedKeyword) {
          return false
        }

        const bareKeyword =
          normalizedKeyword.startsWith("ال") && normalizedKeyword.length > 2
            ? normalizedKeyword.slice(2)
            : normalizedKeyword

        return (
          normalizedKeyword === token ||
          normalizedKeyword === bareToken ||
          bareKeyword === token ||
          bareKeyword === bareToken
        )
      })
    )

    if (matchedEntry) {
      matchedSourceTypes.add(matchedEntry.type)
      if (matchedEntry.type !== "OTHER") {
        continue
      }
    }

    if (!seenTokens.has(token)) {
      remainingTokens.push(token)
      seenTokens.add(token)
    }
  }

  const descriptionTokenSet = new Set<string>(remainingTokens)

  for (const token of remainingTokens) {
    const variants = tokenVariants.get(token)
    if (!variants) {
      continue
    }

    for (const variant of variants) {
      if (variant) {
        descriptionTokenSet.add(variant)
        descriptionTokenSet.add(variant.toLowerCase())
      }
    }
  }

  if (remainingTokens.length > 1) {
    const normalizedPhrase = remainingTokens.join(" ")
    descriptionTokenSet.add(normalizedPhrase)

    const rawPhrase = remainingTokens
      .map((token) => {
        const variants = tokenVariants.get(token)
        return variants?.[0] ?? token
      })
      .join(" ")

    if (rawPhrase) {
      descriptionTokenSet.add(rawPhrase)
      descriptionTokenSet.add(rawPhrase.toLowerCase())
    }
  }

  const tokensForFilter = Array.from(descriptionTokenSet).filter(Boolean)
  const descriptionSummary = tokensForFilter.join(", ").trim() || null

  return {
    normalizedSearch,
    matchedSourceTypes,
    descriptionTokens: tokensForFilter,
    descriptionSummary,
    tokenVariants
  }
}
