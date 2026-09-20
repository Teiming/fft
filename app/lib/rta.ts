// Base-10 third-octave bands centered on 1 kHz (20 Hz through 20 kHz).
export const bands = Array.from({ length: 31 }, (_, index) => {
  const center = 1000 * 10 ** ((index - 17) / 10)
  return { center, lower: center / 10 ** 0.05, upper: center * 10 ** 0.05 }
})

// Integrate linear power, sharing boundary bins by their frequency overlap.
// Blackman window / one-sided power correction is applied by the renderer.
export function bandPower(data: Float32Array, binWidth: number, lower: number, upper: number) {
  let power = 0
  const first = Math.max(1, Math.floor(lower / binWidth - 0.5))
  const last = Math.min(data.length - 1, Math.ceil(upper / binWidth + 0.5))
  for (let bin = first; bin <= last; bin++) {
    if (!Number.isFinite(data[bin])) continue
    const overlap = Math.max(0,
      Math.min(upper, (bin + 0.5) * binWidth) - Math.max(lower, (bin - 0.5) * binWidth))
    power += 10 ** (data[bin] / 10) * overlap / binWidth
  }
  return power
}
