/* block_ids_worldcode.js  ブロックの番号と名前を調べて、チャットに出す(リプレイエディタの表に足すため)
   使い方: ワールドコードに入れて、チャットで  !ids  (4361 から)  または  !ids 1  (全部)
   出てきた「番号,名前」の行を、テキストファイル block_ids.txt にそのまま貼る。
   それを tools/update_from_official.py に渡すと、block_id_to_root.csv に足される。
   ゲームに時間を使いすぎないよう、1 tick に 100 個ずつ調べる。名前の無い番号が 300 続いたら終わる。 */

BIDS = null

onPlayerChat = (pid, msg) => {
  const m = /^!ids(?:\s+(\d+))?\s*$/.exec(msg)
  if (!m) return
  BIDS = { pid: pid, id: m[1] ? Number(m[1]) : 4361, miss: 0, out: [] }
  api.sendMessage(pid, "ブロックの番号を調べています… " + BIDS.id + " から")
  return false
}

tick = () => {
  if (!BIDS) return
  for (let n = 0; n < 100 && BIDS; n++) {
    let name = null
    try { name = api.blockIdToBlockName(BIDS.id) } catch (e) { name = null }
    if (name) { BIDS.out.push(BIDS.id + "," + name); BIDS.miss = 0 } else { BIDS.miss++ }
    BIDS.id++
    if (BIDS.miss > 300) {
      const b = BIDS
      BIDS = null
      if (!b.out.length) { api.sendMessage(b.pid, "新しい番号はありませんでした"); return }
      for (let i = 0; i < b.out.length; i += 12) api.sendMessage(b.pid, b.out.slice(i, i + 12).join(" ; "))
      api.sendMessage(b.pid, "おわり: " + b.out.length + " 個")
    }
  }
}
