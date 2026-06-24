import { useEffect, useState } from 'react'

export default function SplashScreen({ onDone }) {
  const [phase, setPhase] = useState('in')

  useEffect(() => {
    const fadeOut = setTimeout(() => setPhase('out'), 1700)
    const done    = setTimeout(() => onDone?.(),       2150)
    return () => { clearTimeout(fadeOut); clearTimeout(done) }
  }, [onDone])

  return (
    <div
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         99999,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        background:     'linear-gradient(160deg, #003B6F 0%, #005293 55%, #0a1628 100%)',
        transition:     'opacity 0.45s ease-out',
        opacity:        phase === 'out' ? 0 : 1,
        pointerEvents:  phase === 'out' ? 'none' : 'auto',
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
        @keyframes sp-lion {
          from { opacity: 0; transform: translateY(14px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
        @keyframes sp-pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.07); }
        }
        @keyframes sp-glare {
          0%   { opacity: 0;    transform: translate(-34px, 30px)  rotate(-52deg); }
          25%  { opacity: 0.55; }
          75%  { opacity: 0.45; }
          100% { opacity: 0;    transform: translate(36px, -42px)  rotate(-52deg); }
        }
      `}</style>

      <div style={{ position: 'relative', width: 260, height: 390 }}>

        {/* Glow */}
        <div style={{
          position:     'absolute',
          top:          10,
          left:         '50%',
          width:        200,
          height:       200,
          marginLeft:   -100,
          borderRadius: '50%',
          background:   'radial-gradient(circle, rgba(255,217,90,0.30) 0%, rgba(255,201,40,0.12) 55%, transparent 75%)',
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

        {/* Lion */}
        <img
          src="/lejon.png"
          alt=""
          draggable={false}
          style={{
            position:   'absolute',
            bottom:     0,
            left:       '50%',
            width:      240,
            marginLeft: -120,
            animation:  'sp-lion 0.5s cubic-bezier(0.22,1,0.36,1) 0.72s both',
            filter:     'drop-shadow(0 4px 20px rgba(0,0,0,0.6))',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />

        {/* Sword glare */}
        <div style={{
          position:     'absolute',
          top:          122,
          left:         '50%',
          width:        90,
          height:       8,
          marginLeft:   -10,
          borderRadius: 4,
          background:   'linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)',
          animation:    'sp-glare 0.55s ease-in-out 1.28s both',
          transform:    'rotate(-52deg)',
          pointerEvents: 'none',
        }} />

      </div>
    </div>
  )
}
