import { useEffect } from 'react'

export default function SplashScreen({ onAnimReady, fading }) {
  useEffect(() => {
    const t = setTimeout(() => onAnimReady?.(), 1700)
    return () => clearTimeout(t)
  }, [onAnimReady])

  return (
    <div
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         99999,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        background:     'linear-gradient(to bottom, #000d1a 0%, #001e3d 35%, #003470 65%, #005099 100%)',
        transition:     'opacity 0.45s ease-out',
        opacity:        fading ? 0 : 1,
        pointerEvents:  fading ? 'none' : 'auto',
        overflow:       'hidden',
      }}
    >
      <style>{`
        @keyframes sp-rise {
          from { transform: translateY(60px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes sp-spin {
          from { transform: rotate(-15deg) scale(0); opacity: 0; }
          40%  { transform: rotate(0deg)  scale(1.12); opacity: 1; }
          65%  { transform: rotate(0deg)  scale(0.94); }
          85%  { transform: rotate(0deg)  scale(1.04); }
          to   { transform: rotate(0deg)  scale(1);    opacity: 1; }
        }
        @keyframes sp-pop {
          from { transform: scale(0); opacity: 0; }
          50%  { transform: scale(1.15); opacity: 1; }
          70%  { transform: scale(0.92); }
          85%  { transform: scale(1.06); }
          to   { transform: scale(1);    opacity: 1; }
        }
        @keyframes sp-bridge {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes sp-pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.07); }
        }
      `}</style>

      {/* Sun elements — centered in screen */}
      <div style={{ position: 'relative', width: 260, height: 260, flexShrink: 0 }}>

        {/* Glow */}
        <div style={{
          position:     'absolute',
          top:          10,
          left:         '50%',
          width:        200,
          height:       200,
          marginLeft:   -100,
          borderRadius: '50%',
          background:   'radial-gradient(circle, rgba(255,217,90,0.35) 0%, rgba(255,201,40,0.14) 55%, transparent 75%)',
          animation:    'sp-rise 0.55s cubic-bezier(0.22,1,0.36,1) 0.1s both, sp-pulse 2.2s ease-in-out 1.1s infinite',
          transformOrigin: 'center center',
        }} />

        {/* Sun rays */}
        <div style={{
          position:   'absolute',
          top:        10,
          left:       '50%',
          width:      190,
          height:     190,
          marginLeft: -95,
          animation:  'sp-rise 0.55s cubic-bezier(0.22,1,0.36,1) 0.1s both',
        }}>
          <svg viewBox="0 0 190 190" style={{
            width: '100%', height: '100%',
            animation:       'sp-spin 0.72s cubic-bezier(0.22,1,0.36,1) 0.22s both',
            transformOrigin: '95px 95px',
          }}>
            {[0,30,60,90,120,150,180,210,240,270,300,330].map(deg => (
              <polygon key={deg}
                points="95,8 100,84 95,92 90,84"
                fill="#FFC928"
                opacity={deg % 60 === 0 ? 0.9 : 0.65}
                transform={`rotate(${deg} 95 95)`}
              />
            ))}
          </svg>
        </div>

        {/* Sun circle */}
        <div style={{
          position:     'absolute',
          top:          51,
          left:         '50%',
          width:        110,
          height:       110,
          marginLeft:   -55,
          borderRadius: '50%',
          background:   'radial-gradient(circle at 38% 38%, #FFE27A 0%, #FFD95A 45%, #FFC928 100%)',
          boxShadow:    '0 0 28px rgba(255,201,40,0.55)',
          animation:    'sp-pop 0.68s cubic-bezier(0.22,1,0.36,1) 0.28s both, sp-pulse 2.2s ease-in-out 1.1s infinite',
          transformOrigin: 'center center',
        }} />
      </div>

      {/* Bridge — full width, anchored to bottom */}
      <img
        src="/lejon.webp"
        alt=""
        draggable={false}
        style={{
          position:      'absolute',
          bottom:        0,
          left:          '50%',
          transform:     'translateX(-50%)',
          width:         '100%',
          maxHeight:     '55vh',
          objectFit:     'contain',
          objectPosition:'bottom center',
          animation:     'sp-bridge 0.6s cubic-bezier(0.22,1,0.36,1) 0.5s both',
          userSelect:    'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
