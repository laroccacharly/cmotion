import { expect, test } from "bun:test"
import { inspectTime, sheetFilter } from "../ts/inspect.ts"

test("the inspect still lands on a frame before the scene's fade-out", () => {
  expect(inspectTime(9.2, 30)).toBeCloseTo(8.7, 5)
  expect(inspectTime(9.2, 30)).toBeLessThan(9.2 - 0.4)
  expect(inspectTime(0.2, 30)).toBe(0)
})

test("the sheet tiles every scene in order, and a lone scene needs no stack", () => {
  const filter = sheetFilter(["01  intro", "02  it's: 50%", "03  close"], { width: 1920, height: 1080 }, { columns: 2, width: 640 })
  expect(filter).toContain("xstack=inputs=3:layout=0_0|656_0|0_420")
  expect(filter).toContain("text='02  it\\'s\\: 50\\%'")
  expect(sheetFilter(["01  intro"], { width: 1920, height: 1080 }, { columns: 3, width: 640 })).toContain("[c0]null")
})
