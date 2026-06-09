import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import MobileApp from './MobileApp.jsx'
import DesktopApp from './DesktopApp.jsx'

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
  return (
    <Routes>
      <Route path="/" element={isDesktop ? <DesktopApp /> : <MobileApp />} />
      <Route path="/mobile" element={<MobileApp />} />
      <Route path="/desktop" element={<DesktopApp />} />
      <Route path="/admin" element={<App />} />
    </Routes>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
)
