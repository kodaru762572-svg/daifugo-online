// 大富豪オンライン: ブラウザから「アプリとしてインストール」できるようにするための
// 最小限のService Worker。
//
// あえてキャッシュは一切行わない(常にネットワークから最新のファイルを取りに行くだけ)。
// このゲームは頻繁に更新するため、下手にキャッシュすると更新後も古い画面/JSが
// 表示され続けてしまう("動かない"問い合わせの原因になる)ほうが問題が大きいと判断した。
// installできる条件を満たすための最小構成として、fetchイベントを持つだけにしている。

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
