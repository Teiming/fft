'use client'

import { useEffect, useRef, useState } from 'react'

const minimumFrequency = 20
const maximumFrequency = 20000
const minimumDb = -100
const maximumDb = -30
const margin = { top: 30, right: 35, bottom: 60, left: 70 }

function drawAxes(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const plotWidth = canvas.width - margin.left - margin.right
  const plotHeight = canvas.height - margin.top - margin.bottom
  const bottom = margin.top + plotHeight
  const frequencyToX = (frequency: number) =>
    margin.left +
    (Math.log10(frequency / minimumFrequency) /
      Math.log10(maximumFrequency / minimumFrequency)) * plotWidth
  const dbToY = (db: number) =>
    margin.top + ((maximumDb - db) / (maximumDb - minimumDb)) * plotHeight

  context.fillStyle = '#111'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = '14px sans-serif'
  context.lineWidth = 1
  context.fillStyle = '#ccc'
  context.textAlign = 'center'
  context.textBaseline = 'top'

  for (const frequency of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = frequencyToX(frequency)
    context.strokeStyle = '#333'
    context.beginPath()
    context.moveTo(x, margin.top)
    context.lineTo(x, bottom)
    context.stroke()
    context.fillText(frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`, x, bottom + 10)
  }

  context.textAlign = 'right'
  context.textBaseline = 'middle'

  for (let db = minimumDb; db <= maximumDb; db += 10) {
    const y = dbToY(db)
    context.strokeStyle = '#333'
    context.beginPath()
    context.moveTo(margin.left, y)
    context.lineTo(margin.left + plotWidth, y)
    context.stroke()
    context.fillText(`${db}`, margin.left - 10, y)
  }

  context.strokeStyle = '#888'
  context.strokeRect(margin.left, margin.top, plotWidth, plotHeight)
  context.textAlign = 'center'
  context.fillText('주파수 (Hz)', margin.left + plotWidth / 2, canvas.height - 15)
  context.save()
  context.translate(18, margin.top + plotHeight / 2)
  context.rotate(-Math.PI / 2)
  context.fillText('신호 레벨 (dB)', 0, 0)
  context.restore()

  return { frequencyToX, dbToY }
}

export default function Spectrum() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationRef = useRef<number | null>(null)

  const [running, setRunning] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) drawAxes(canvas, context)
  }, [])

  async function start() {
    if (running) return

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    const audioContext = new AudioContext()

    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()

    analyser.fftSize = 8192
    analyser.smoothingTimeConstant = 0.7
    analyser.minDecibels = minimumDb
    analyser.maxDecibels = maximumDb

    source.connect(analyser)

    const data = new Float32Array(analyser.frequencyBinCount)

    audioContextRef.current = audioContext
    streamRef.current = stream

    const canvas = canvasRef.current

    if (!canvas) return

    const context = canvas.getContext('2d')

    if (!context) return

    function draw() {
      analyser.getFloatFrequencyData(data)
      if (!canvas) throw new Error('no canvas')
      if (!context) throw new Error('no context')

      const { frequencyToX, dbToY } = drawAxes(canvas, context)

      context.strokeStyle = '#fff'
      context.lineWidth = 1

      context.beginPath()

      const sampleRate = audioContext.sampleRate
      const binWidth = sampleRate / analyser.fftSize

      let drawing = false

      for (let i = 0; i < data.length; i++) {
        const frequency = i * binWidth

        if (frequency < minimumFrequency || frequency > maximumFrequency) {
          continue
        }

        const x = frequencyToX(frequency)
        const db = Number.isFinite(data[i]) ? data[i] : minimumDb
        const y = dbToY(Math.max(minimumDb, Math.min(maximumDb, db)))

        if (!drawing) {
          context.moveTo(x, y)
          drawing = true
        } else {
          context.lineTo(x, y)
        }
      }

      context.stroke()

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    setRunning(true)
  }

  async function stop() {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
    }

    streamRef.current?.getTracks().forEach(track => track.stop())

    await audioContextRef.current?.close()

    animationRef.current = null
    streamRef.current = null
    audioContextRef.current = null

    setRunning(false)
  }

  return (
    <main>
      <canvas
        ref={canvasRef}
        width={1000}
        height={500}
        role="img"
        aria-label="오디오 스펙트럼: 가로축 주파수 20 Hz~20 kHz, 세로축 신호 레벨 -100~-30 dB"
        style={{
          width: '100%',
          maxWidth: 1000,
          background: '#111',
        }}
      />

      <div
        style={{
          marginTop: 20,
          display: 'flex',
          gap: 10,
        }}
      >
        <button onClick={start}>시작</button>

        <button onClick={stop}>정지</button>
      </div>
    </main>
  )
}
