'use client'

import Link from 'next/link'
import { bands, bandPower } from '../lib/rta'
import { useEffect, useRef, useState } from 'react'

const minimumFrequency = 20
const maximumFrequency = 20000
const minimumDb = -100
const maximumDb = 20
const splReferenceOffset = 20 * Math.log10(1 / 0.00002)
// One-sided bin power, corrected for the Web Audio Blackman window's mean square.
const binPowerCorrection = 10 * Math.log10(2 / (0.42 ** 2 + (0.5 ** 2 + 0.08 ** 2) / 2))
const margin = { top: 30, right: 35, bottom: 60, left: 70 }

function drawAxes(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, rta: boolean) {
  const lowFrequency = rta ? bands[0].lower : minimumFrequency
  const highFrequency = rta ? bands[bands.length - 1].upper : maximumFrequency
  const plotWidth = canvas.width - margin.left - margin.right
  const plotHeight = canvas.height - margin.top - margin.bottom
  const bottom = margin.top + plotHeight
  const frequencyToX = (frequency: number) =>
    margin.left +
    (Math.log10(frequency / lowFrequency) /
      Math.log10(highFrequency / lowFrequency)) * plotWidth
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
  context.fillText(rta ? '음압 (dBPa / 1/3옥타브)' : '음압 (dBPa / FFT bin)', 0, 0)
  context.restore()

  return { frequencyToX, dbToY }
}

export default function Spectrum({ rta = false }: { rta?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationRef = useRef<number | null>(null)
  const calibrationOffsetRef = useRef<number | null>(null)
  const calibrationRef = useRef<{
    startedAt: number
    referenceSpl: number
    sumSquares: number
    samples: number
    clipped: boolean
  } | null>(null)

  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [referenceSpl, setReferenceSpl] = useState('94')
  const [calibrating, setCalibrating] = useState(false)
  const [calibrated, setCalibrated] = useState(false)
  const [message, setMessage] = useState('음압 보정이 필요합니다.')

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) drawAxes(canvas, context, rta)
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
      const audioContext = audioContextRef.current
      audioContextRef.current = null
      if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => {})
      calibrationRef.current = null
    }
  }, [rta])

  async function start() {
    if (running || starting) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMessage('마이크를 사용하려면 HTTPS 주소로 접속해 주세요.')
      return
    }
    setStarting(true)
    try {
      // Resume directly within the button gesture, before requesting microphone access.
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      await audioContext.resume()
      await startMeasurement(audioContext)
    } catch {
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
      await audioContextRef.current?.close().catch(() => {})
      audioContextRef.current = null
      setMessage('마이크를 시작하지 못했습니다. 마이크 권한과 연결을 확인해 주세요.')
    } finally {
      setStarting(false)
    }
  }

  async function startMeasurement(audioContext: AudioContext) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    if (audioContextRef.current !== audioContext) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    streamRef.current = stream
    await audioContext.resume()

    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()

    analyser.fftSize = rta ? 32768 : 8192
    analyser.smoothingTimeConstant = 0

    source.connect(analyser)

    const data = new Float32Array(analyser.frequencyBinCount)
    const waveform = new Float32Array(analyser.fftSize)

    calibrationOffsetRef.current = null
    setCalibrated(false)
    setMessage('일정한 소리를 유지하고 기준 소음계 값을 입력한 뒤 보정해 주세요.')

    const canvas = canvasRef.current

    if (!canvas) throw new Error('no canvas')

    const context = canvas.getContext('2d')

    if (!context) throw new Error('no context')

    function draw() {
      analyser.getFloatFrequencyData(data)
      if (!canvas) throw new Error('no canvas')
      if (!context) throw new Error('no context')

      const { frequencyToX, dbToY } = drawAxes(canvas, context, rta)

      const calibration = calibrationRef.current
      if (calibration) {
        analyser.getFloatTimeDomainData(waveform)
        const mean = waveform.reduce((sum, sample) => sum + sample, 0) / waveform.length
        for (const sample of waveform) {
          calibration.sumSquares += (sample - mean) ** 2
          calibration.samples++
          if (Math.abs(sample) >= 0.999) calibration.clipped = true
        }
        if (performance.now() - calibration.startedAt >= 1000) {
          const power = calibration.sumSquares / calibration.samples
          if (calibration.clipped || !Number.isFinite(power) || power <= 1e-12) {
            setMessage('신호가 너무 작거나 입력이 포화되었습니다. 소리 크기를 조절한 뒤 다시 보정해 주세요.')
          } else {
            calibrationOffsetRef.current = calibration.referenceSpl - splReferenceOffset - 10 * Math.log10(power)
            setCalibrated(true)
            setMessage(`보정 완료: 기준 ${calibration.referenceSpl} dB SPL. 마이크나 입력 볼륨을 바꾸면 다시 보정해 주세요.`)
          }
          calibrationRef.current = null
          setCalibrating(false)
        }
      }

      const offset = calibrationOffsetRef.current
      if (offset === null) {
        context.fillStyle = '#ccc'
        context.fillText('기준 소음계 값으로 보정하면 음압이 표시됩니다.', canvas.width / 2, canvas.height / 2)
        animationRef.current = requestAnimationFrame(draw)
        return
      }

      if (rta) {
        const binWidth = audioContext.sampleRate / analyser.fftSize
        const bottom = dbToY(minimumDb)
        for (const band of bands) {
          const left = frequencyToX(band.lower) + 1
          const width = frequencyToX(band.upper) - left - 1
          // Do not show a partial band as a complete measurement above Nyquist.
          if (band.upper > audioContext.sampleRate / 2) {
            context.fillStyle = '#555'
            context.fillRect(left, margin.top, width, bottom - margin.top)
            continue
          }
          const power = bandPower(data, binWidth, band.lower, band.upper)
          const db = power > 0 ? 10 * Math.log10(power) + binPowerCorrection + offset : minimumDb
          const top = dbToY(Math.max(minimumDb, Math.min(maximumDb, db)))
          context.fillStyle = '#38bdf8'
          context.fillRect(left, top, width, bottom - top)
        }
        animationRef.current = requestAnimationFrame(draw)
        return
      }

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
        const db = Number.isFinite(data[i]) ? data[i] + binPowerCorrection + offset : minimumDb
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
    calibrationRef.current = null
    setCalibrating(false)
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

  function calibrate() {
    const level = Number(referenceSpl)
    if (!running || calibrating) return
    if (!referenceSpl.trim() || !Number.isFinite(level) || level < 0 || level > 160) {
      setMessage('기준 소음계 값을 0~160 dB SPL 범위로 입력해 주세요.')
      return
    }
    calibrationRef.current = {
      startedAt: performance.now(), referenceSpl: level,
      sumSquares: 0, samples: 0, clipped: false,
    }
    setCalibrating(true)
    setMessage('보정 중입니다. 1초 동안 소리를 일정하게 유지해 주세요.')
  }

  return (
    <main>
      <nav aria-label="분석 화면" style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
        <Link href="/" aria-current={!rta ? 'page' : undefined}>FFT 스펙트럼</Link>
        <Link href="/RTA" aria-current={rta ? 'page' : undefined}>1/3옥타브 RTA</Link>
      </nav>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>{rta ? '1/3옥타브 RTA' : 'FFT 스펙트럼'}</h1>
      <canvas
        ref={canvasRef}
        width={1000}
        height={500}
        role="img"
        aria-label={`${rta ? '1/3옥타브 RTA' : '오디오 스펙트럼'}: 가로축 20 Hz~20 kHz, 세로축 -100~20 dBPa (${rta ? '1/3옥타브 대역별 음압' : 'FFT 구간별 음압'}). ${calibrated ? '보정 완료' : '미보정'}`}
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
        <button onClick={start} disabled={running || starting}>{starting ? '연결 중…' : '시작'}</button>

        <button onClick={stop} disabled={!running}>정지</button>
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          기준 소음계 (dB SPL, Z 가중치){' '}
          <input type="number" min={0} max={160} step="0.1" value={referenceSpl}
            onChange={event => setReferenceSpl(event.target.value)} disabled={calibrating}
            style={{ width: 90, border: '1px solid #888', padding: 4 }} />
        </label>
        <button onClick={calibrate} disabled={!running || calibrating}>
          {calibrating ? '보정 중…' : '현재 소리로 보정 (1초)'}
        </button>
      </div>
      <p role="status" style={{ marginTop: 12 }}>{message}</p>
      <p style={{ marginTop: 8 }}>
        0 dBPa = 1 Pa ≈ 94 dB SPL. 두 마이크를 가까이 두고 일정한 소리로 보정하세요.
        A/C 가중치 값은 직접 사용할 수 없습니다. 이 보정은 마이크의 주파수 응답 차이까지 보정하지 않습니다.
      </p>
      <p>그래프는 {rta ? '1/3옥타브 대역별' : 'FFT 구간별'} 음압이며 전체 소음계 값과 다릅니다. 세로축 표시 범위는 -100~20 dBPa입니다.</p>
      {rta && <p>20 Hz~20 kHz, 31개 대역 · FFT 에너지 합산 방식으로 저주파 대역은 근사값입니다. 회색 대역은 입력 샘플레이트 제한으로 측정할 수 없습니다.</p>}
    </main>
  )
}
