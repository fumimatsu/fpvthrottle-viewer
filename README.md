# FPV Throttle Viewer

A lightweight, client-side web application that extracts throttle (0-100) readings from an MP4 video and plots them over time.

## Features

- Upload any MP4 video directly in the browser (no server required)
- Draw a bounding box around the on-screen numeric throttle indicator
- Configure the sampling interval and run OCR frame-by-frame with Tesseract.js
- Visualize results on an interactive Chart.js line graph
- Review a table of recognized values and download them as CSV

## Getting started

1. Open `index.html` in a modern desktop browser (Chrome, Edge, or Firefox).
2. Choose an MP4 file that includes a numeric throttle readout.
3. Pause on a frame where the number is visible and drag over it to define the region of interest.
4. (Optional) Adjust the frame interval to balance accuracy and processing time.
5. Click **Analyze video** to extract throttle values, visualize them, and export the CSV if needed.

> **Tip:** For best recognition accuracy, ensure the throttle digits have strong contrast with the background and keep the selection tight around the numbers.

### Running inside this workspace

1. Start a simple static server from the project root:
   ```bash
   python -m http.server 8000
   ```
2. Open the forwarded URL for port `8000` in your browser (for example, via the **Ports** tab or by visiting `https://<host>/proxy/8000/`).
3. The app will load automatically from `index.html`; proceed with the steps above to analyze your video.

Because everything runs in the browser, no additional dependencies or build steps are required.

## プロダクト概要（日本語）

FPV Throttle Viewer は、FPV ドローンのフライト動画からスロットル値（0〜100）を抽出し、経過時間とともに可視化するシングルページアプリケーションです。ブラウザだけで完結するため、動画をアップロードするだけで簡単に解析を始められます。

### 主な機能

- MP4 動画の読み込みと、画面上のスロットル値表示エリアの指定
- Tesseract.js を利用したフレーム単位の文字認識と、サンプリング間隔の調整
- Chart.js によるスロットル値の折れ線グラフ表示と、数値一覧テーブル
- 解析結果の CSV ダウンロード機能

### 使い方の流れ

1. `index.html` をブラウザで開き、解析したい MP4 動画を選択します。
2. スロットル値が画面に表示されているフレームで一時停止し、数字を囲むように範囲をドラッグします。
3. 必要に応じてサンプリング間隔を調整し、「Analyze video」をクリックすると解析が開始されます。
4. 抽出された値は折れ線グラフとテーブルに表示され、CSV として保存することもできます。

> **ヒント:** 認識精度を高めるには、対象の数字が鮮明に映るシーンを選び、選択範囲を数字の周囲にぴったり合わせるようにしてください。
