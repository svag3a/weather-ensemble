import { StrictMode, useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import SplashScreen from './components/SplashScreen.jsx'

const App        = lazy(() => import('./App.jsx'))
const MobileApp  = lazy(() => import('./MobileApp.jsx'))
const DesktopApp = lazy(() => import('./DesktopApp.jsx'))

function useIsDesktop() {
  const mq = window.matchMedia('(min-width: 1024px)')
  const [isDesktop, setIsDesktop] = useState(mq.matches)
  useEffect(() => {
    const handler = e => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return isDesktop
}

function Root() {
  const isDesktop = useIsDesktop()
  const [showSplash, setShowSplash] = useState(true)
  const [splashFading, setSplashFading] = useState(false)
  const flags = useRef({ anim: false, data: false })
  const dismissing = useRef(false)

  const tryDismiss = useCallback(() => {
    if (flags.current.anim && flags.current.data && !dismissing.current) {
      dismissing.current = true
      setSplashFading(true)
      setTimeout(() => setShowSplash(false), 500)
    }
  }, [])

  const handleAnimReady = useCallback(() => { flags.current.anim = true; tryDismiss() }, [tryDismiss])
  const handleDataReady = useCallback(() => { flags.current.data = true; tryDismiss() }, [tryDismiss])

  // Fallback: dismiss after 8s even if data never arrives
  useEffect(() => {
    const t = setTimeout(() => { flags.current.anim = true; flags.current.data = true; tryDismiss() }, 8000)
    return () => clearTimeout(t)
  }, [tryDismiss])

  return (
    <>
      {showSplash && <SplashScreen onAnimReady={handleAnimReady} fading={splashFading} />}
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={isDesktop ? <DesktopApp /> : <MobileApp onReady={handleDataReady} />} />
          <Route path="/mobile" element={<MobileApp onReady={handleDataReady} />} />
          <Route path="/desktop" element={<DesktopApp />} />
          <Route path="/admin" element={<App />} />
        </Routes>
      </Suspense>
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
)
