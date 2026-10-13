import { readBolt11Tags } from './bolt11-tags'

const TIMESTAMP = Array(7).fill(0)
const SIGNATURE = Array(104).fill(0)

describe('readBolt11Tags', () => {
  it('reads each tag and where the signature starts', () => {
    const words = [...TIMESTAMP, 23, 0, 2, 5, 6, 13, 0, 1, 7, ...SIGNATURE]
    const { tags, end } = readBolt11Tags(words)
    expect(tags.get(23)).toEqual([5, 6])
    expect(tags.get(13)).toEqual([7])
    expect(end).toBe(words.length - 104)
  })

  it('throws on a tag that runs into the signature', () => {
    const words = [...TIMESTAMP, 23, 1, 20, 1, 2, 3, ...SIGNATURE]
    expect(() => readBolt11Tags(words)).toThrow('BOLT11 tag overruns')
  })

  it('throws on a repeated single-use tag such as h', () => {
    const words = [...TIMESTAMP, 23, 0, 1, 1, 23, 0, 1, 2, ...SIGNATURE]
    expect(() => readBolt11Tags(words)).toThrow('repeated BOLT11 tag')
  })

  it('allows a repeated multi-use tag such as r', () => {
    const words = [...TIMESTAMP, 3, 0, 1, 1, 3, 0, 1, 2, ...SIGNATURE]
    expect(readBolt11Tags(words).tags.get(3)).toEqual([2])
  })
})
