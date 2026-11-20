const BLOCKS_L = [
  null,
  [[1, 26, 19]],
  [[1, 44, 34]],
  [[1, 70, 55]],
  [[1, 100, 80]],
  [[1, 134, 108]],
  [[2, 86, 68]],
  [[2, 98, 78]],
  [[2, 121, 97]],
  [[2, 146, 116]],
  [[2, 86, 68], [2, 87, 69]],
]

const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38],
  [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

function appendBits(target, value, count) {
  for (let bit = count - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1)
}

function fieldMultiply(left, right, exp, log) {
  if (left === 0 || right === 0) return 0
  return exp[log[left] + log[right]]
}

function fieldTables() {
  const exp = Array(512).fill(0)
  const log = Array(256).fill(0)
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value
    log[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < exp.length; index += 1) exp[index] = exp[index - 255]
  return { exp, log }
}

function generatorPolynomial(degree, exp, log) {
  let polynomial = [1]
  for (let root = 0; root < degree; root += 1) {
    const next = Array(polynomial.length + 1).fill(0)
    for (let index = 0; index < polynomial.length; index += 1) {
      next[index] ^= polynomial[index]
      next[index + 1] ^= fieldMultiply(polynomial[index], exp[root], exp, log)
    }
    polynomial = next
  }
  return polynomial
}

function reedSolomonRemainder(data, degree, exp, log) {
  const generator = generatorPolynomial(degree, exp, log)
  const remainder = [...data, ...Array(degree).fill(0)]
  for (let offset = 0; offset < data.length; offset += 1) {
    const factor = remainder[offset]
    if (!factor) continue
    for (let index = 0; index < generator.length; index += 1) {
      remainder[offset + index] ^= fieldMultiply(generator[index], factor, exp, log)
    }
  }
  return remainder.slice(data.length)
}

function dataCodewords(bytes, version, blocks) {
  const dataLength = blocks.reduce((total, block) => total + block[0] * block[2], 0)
  const bits = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) appendBits(bits, byte, 8)
  const capacity = dataLength * 8
  for (let index = 0; index < Math.min(4, capacity - bits.length); index += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords = []
  for (let offset = 0; offset < bits.length; offset += 8) {
    let byte = 0
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[offset + bit]
    codewords.push(byte)
  }
  for (let pad = 0xec; codewords.length < dataLength; pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

function interleave(bytes, version, blocks, exp, log) {
  const data = dataCodewords(bytes, version, blocks)
  const groups = []
  let offset = 0
  let errorLength = 0
  for (const [count, total, dataLength] of blocks) {
    errorLength = total - dataLength
    for (let block = 0; block < count; block += 1) {
      const body = data.slice(offset, offset + dataLength)
      offset += dataLength
      groups.push({ data: body, error: reedSolomonRemainder(body, errorLength, exp, log) })
    }
  }
  const out = []
  const maxData = Math.max(...groups.map(group => group.data.length))
  for (let index = 0; index < maxData; index += 1) {
    for (const group of groups) if (index < group.data.length) out.push(group.data[index])
  }
  for (let index = 0; index < errorLength; index += 1) {
    for (const group of groups) out.push(group.error[index])
  }
  return out
}

function bch(value, polynomial) {
  const degree = 31 - Math.clz32(polynomial)
  let result = value
  while (31 - Math.clz32(result) >= degree) result ^= polynomial << ((31 - Math.clz32(result)) - degree)
  return result
}

function maskBit(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return column % 3 === 0
    case 3: return (row + column) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0
    case 5: return row * column % 2 + row * column % 3 === 0
    case 6: return (row * column % 2 + row * column % 3) % 2 === 0
    default: return ((row + column) % 2 + row * column % 3) % 2 === 0
  }
}

function buildMatrix(version, words, mask) {
  const size = version * 4 + 17
  const matrix = Array.from({ length: size }, () => Array(size).fill(false))
  const functions = Array.from({ length: size }, () => Array(size).fill(false))
  const setFunction = (row, column, dark) => {
    if (row < 0 || row >= size || column < 0 || column >= size) return
    matrix[row][column] = dark
    functions[row][column] = true
  }
  const finder = (centerRow, centerColumn) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const absoluteRow = centerRow + row
        const absoluteColumn = centerColumn + column
        const dark = row >= 0 && row <= 6 && column >= 0 && column <= 6
          && (row === 0 || row === 6 || column === 0 || column === 6
            || row >= 2 && row <= 4 && column >= 2 && column <= 4)
        setFunction(absoluteRow, absoluteColumn, dark)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)
  for (const row of ALIGNMENT[version]) {
    for (const column of ALIGNMENT[version]) {
      if (functions[row][column]) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(row + dy, column + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }
  for (let index = 8; index < size - 8; index += 1) {
    if (!functions[6][index]) setFunction(6, index, index % 2 === 0)
    if (!functions[index][6]) setFunction(index, 6, index % 2 === 0)
  }
  const formatData = (0b01 << 3) | mask
  const formatBits = ((formatData << 10) | bch(formatData << 10, 0x537)) ^ 0x5412
  for (let index = 0; index < 15; index += 1) {
    const dark = ((formatBits >>> index) & 1) !== 0
    const verticalRow = index < 6 ? index : index < 8 ? index + 1 : size - 15 + index
    const horizontalColumn = index < 8 ? size - index - 1 : index < 9 ? 7 : 14 - index
    setFunction(verticalRow, 8, dark)
    setFunction(8, horizontalColumn, dark)
  }
  setFunction(size - 8, 8, true)
  if (version >= 7) {
    const versionBits = (version << 12) | bch(version << 12, 0x1f25)
    for (let index = 0; index < 18; index += 1) {
      const dark = ((versionBits >>> index) & 1) !== 0
      const row = Math.floor(index / 3)
      const column = size - 11 + index % 3
      setFunction(row, column, dark)
      setFunction(column, row, dark)
    }
  }
  const bits = words.flatMap(word => Array.from({ length: 8 }, (_value, index) => (word >>> (7 - index)) & 1))
  let bitIndex = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1
    for (let vertical = 0; vertical < size; vertical += 1) {
      const row = upward ? size - 1 - vertical : vertical
      for (let side = 0; side < 2; side += 1) {
        const column = right - side
        if (functions[row][column]) continue
        const bit = bitIndex < bits.length ? bits[bitIndex++] !== 0 : false
        matrix[row][column] = bit !== maskBit(mask, row, column)
      }
    }
    upward = !upward
  }
  return matrix
}

function penalty(matrix) {
  const size = matrix.length
  let score = 0
  const runs = line => {
    let points = 0
    let color = line[0]
    let count = 1
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === color) count += 1
      else {
        if (count >= 5) points += 3 + count - 5
        color = line[index]
        count = 1
      }
    }
    if (count >= 5) points += 3 + count - 5
    for (let index = 0; index <= line.length - 11; index += 1) {
      let window = 0
      for (let bit = 0; bit < 11; bit += 1) window = (window << 1) | Number(line[index + bit])
      if (window === 0x5d0 || window === 0x05d) points += 40
    }
    return points
  }
  for (let row = 0; row < size; row += 1) {
    score += runs(matrix[row])
    score += runs(matrix.map(line => line[row]))
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const color = matrix[row][column]
      if (matrix[row][column + 1] === color && matrix[row + 1][column] === color && matrix[row + 1][column + 1] === color) score += 3
    }
  }
  const dark = matrix.flat().filter(Boolean).length
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10
  return score
}

export function createImQrMatrix(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('A QR payload is required.')
  const bytes = new TextEncoder().encode(text)
  let version = 0
  for (let candidate = 1; candidate < BLOCKS_L.length; candidate += 1) {
    const dataLength = BLOCKS_L[candidate].reduce((total, block) => total + block[0] * block[2], 0)
    const overhead = 4 + (candidate < 10 ? 8 : 16)
    if (bytes.length <= Math.floor((dataLength * 8 - overhead) / 8)) { version = candidate; break }
  }
  if (!version) throw new RangeError('The QR payload exceeds the supported 271-byte limit.')
  const { exp, log } = fieldTables()
  const words = interleave(bytes, version, BLOCKS_L[version], exp, log)
  let best
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, words, mask)
    const score = penalty(candidate)
    if (score < bestScore) { best = candidate; bestScore = score }
  }
  return best
}

export function imQrSvg(text, className = 'bt-im-qr', label = 'WeChat pairing QR code') {
  const matrix = createImQrMatrix(text)
  const quiet = 4
  const size = matrix.length + quiet * 2
  const paths = []
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix.length; column += 1) {
      if (matrix[row][column]) paths.push(`M${column + quiet} ${row + quiet}h1v1h-1z`)
    }
  }
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${paths.join('')}" fill="#111"/></svg>`
}
