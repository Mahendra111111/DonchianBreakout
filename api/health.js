export default function handler(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json({
    ok: true,
    strategies: ['Donchian Breakout', 'Hammer SMA VWAP'],
    service: 'crypto-ema-donchian',
  })
}
