function FogIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"
         style={{ display: 'inline-block', verticalAlign: '-0.15em' }}>
      <rect x="3"  y="1.5"  width="7"  height="2.5" rx="1.25"/>
      <rect x="13" y="1.5"  width="10" height="2.5" rx="1.25"/>
      <rect x="0"  y="6.5"  width="12" height="2.5" rx="1.25"/>
      <rect x="15" y="6.5"  width="7"  height="2.5" rx="1.25"/>
      <rect x="4"  y="11.5" width="10" height="2.5" rx="1.25"/>
      <rect x="17" y="11.5" width="5"  height="2.5" rx="1.25"/>
      <rect x="2"  y="16.5" width="8"  height="2.5" rx="1.25"/>
      <rect x="13" y="16.5" width="9"  height="2.5" rx="1.25"/>
      <rect x="6"  y="21.5" width="12" height="2.5" rx="1.25"/>
    </svg>
  )
}

export default function WeatherSymbol({ symbol }) {
  if (typeof symbol === 'string' && symbol.startsWith('FOG')) {
    // Extract anything after 'FOG_POSSIBLE' or 'FOG' (e.g. '💨')
    const extra = symbol.startsWith('FOG_POSSIBLE')
      ? symbol.slice('FOG_POSSIBLE'.length)
      : symbol.slice('FOG'.length)
    return <span><FogIcon />{extra}</span>
  }
  return <span>{symbol}</span>
}
