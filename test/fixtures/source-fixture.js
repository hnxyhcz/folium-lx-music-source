/**
 * @name Fixture Source
 * @version 1.2.3
 * @description A plaintext LX source used by the runtime tests.
 * @homepage https://example.test/fixture
 */

const { EVENT_NAMES, on, send, utils } = globalThis.lx

const probe = {
  md5Empty: utils.crypto.md5(''),
  md5Abc: utils.crypto.md5('abc'),
  md5Parts: utils.crypto.md5('a', 'b', 'c'),
  hexRoundTrip: utils.buffer.bufToString(utils.buffer.from('00ff10', 'hex'), 'hex'),
  base64RoundTrip: utils.buffer.bufToString(utils.buffer.from('hello', 'utf-8'), 'base64'),
  utf8RoundTrip: utils.buffer.bufToString(utils.buffer.from('你好'), 'utf-8'),
  latin1RoundTrip: utils.buffer.bufToString(utils.buffer.from('\xff\x00', 'latin1'), 'latin1'),
}

send(EVENT_NAMES.inited, {
  status: true,
  sources: {
    wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'], probe },
    tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
  },
})

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') throw new Error(`unsupported action: ${action}`)
  const id = info.musicInfo.songmid || info.musicInfo.hash || info.musicInfo.copyrightId
  const signature = utils.crypto.md5(`${source}:${id}:${info.type}`)
  return new Promise((resolve, reject) => {
    globalThis.lx.request(
      `https://source.test/url/${source}/${id}/${info.type}?sign=${signature}`,
      { headers: { 'x-source': 'fixture' } },
      (error, response) => {
        if (error) {
          reject(error)
          return
        }
        if (response.statusCode !== 200 || !response.body || response.body.code !== 0) {
          reject(new Error(`source error: ${response.body && response.body.code}`))
          return
        }
        resolve(response.body.url)
      },
    )
  })
})
