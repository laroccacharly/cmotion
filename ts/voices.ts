// ElevenLabs default voices, by the name a script uses for them. Every library voice works with eleven_v4.
// Listed from GET /v2/voices?voice_type=default. ElevenLabs retires these defaults on December 31, 2026.
export const Voices = {
  adam: "pNInz6obpgDQGcFmaJgB", // male, American: dominant, firm
  alice: "Xb7hH8MSUJpSbSDYk0k2", // female, British: clear, engaging educator
  bella: "hpp4J3VqNfWAUOO0d1Us", // female, American: professional, bright, warm
  bill: "pqHfZKP75CvOlQylNhV4", // male, American, old: wise, mature, balanced
  brian: "nPczCjzI2devNBz1zQrb", // male, American: deep, resonant, comforting
  callum: "N2lVS1w4EtoT3dr4eOWO", // male, American: husky trickster
  charlie: "IKne3meq5aSn9XLyUdCD", // male, Australian: deep, confident, energetic
  chris: "iP95p4xoKVk53GoZ742B", // male, American: charming, down-to-earth
  daniel: "onwK4e9ZLuTAKqWW03F9", // male, British: steady broadcaster
  eric: "cjVigY5qzO86Huf0OWal", // male, American: smooth, trustworthy
  george: "JBFqnCBsd6RMkjVDRZzb", // male, British: warm, captivating storyteller
  harry: "SOYHLrjzK2X1ezoPC6cr", // male, American: fierce warrior
  jessica: "cgSgspJ2msm6clMCkdW9", // female, American: playful, bright, warm
  laura: "FGY2WhTYpPnrIDTdsKH5", // female, American: enthusiast, quirky
  liam: "TX3LPaxmHKxFdv7VOQHJ", // male, American: energetic social media creator
  lily: "pFZP5JQG7iQjIQuC4Bku", // female, British: velvety actress
  matilda: "XrExE9yKIg1WjnnlVkGX", // female, American: knowledgeable, professional
  river: "SAz9YHcvj6GT2YYXdXww", // neutral, American: relaxed, informative
  roger: "CwhRBWXzGAHq8TQ4Fs17", // male, American: laid-back, casual, resonant
  sarah: "EXAVITQu4vr4xnSDxMaL", // female, American: mature, reassuring, confident
  will: "bIHbv24MWmeRgasZH58o", // male, American: relaxed optimist
} as const

export type Voice = keyof typeof Voices
export const voiceNames = Object.keys(Voices) as ReadonlyArray<Voice>
