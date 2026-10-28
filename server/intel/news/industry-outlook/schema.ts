import { z } from "zod"

export const IndustryOutlookSchema = z.object({
  keyThemes: z.array(z.string()).min(1),
  facts: z.object({
    national: z.string(),
    florida: z.string(),
    miami: z.string(),
  }),
  analysis: z.object({
    national: z.string(),
    florida: z.string(),
    miami: z.string(),
  }),
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().url(),
      })
    )
    .min(0),
})

export type IndustryOutlookJson = z.infer<typeof IndustryOutlookSchema>

export type RetrievedSource = {
  title: string
  url: string
  region: "national" | "florida" | "miami"
  publisher?: string
  date?: string
  snippet?: string
}
