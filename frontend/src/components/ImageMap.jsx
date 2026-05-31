import { useRef } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

// Fix Leaflet default icon paths broken by bundlers
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Custom DivIcon: colored teardrop pin, no embedded label (shown via Tooltip on hover)
function makeIcon(slotCount) {
  const fullness = Math.min(slotCount, 4)
  const colors = ['#475569', '#f97316', '#eab308', '#22c55e', '#3b82f6']
  const bg = colors[fullness]
  const html = `<div style="
    background:${bg};border:2px solid white;border-radius:50% 50% 50% 0;
    width:28px;height:28px;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4);
  "></div>`
  return L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, 28], tooltipAnchor: [14, -14] })
}

// Pending position icon (where user just clicked)
const pendingIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:20px;height:20px;border-radius:50%;
    background:#3b82f6;border:3px solid white;
    box-shadow:0 0 0 3px rgba(59,130,246,.4),0 2px 6px rgba(0,0,0,.3);
  "></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

// Captures map clicks
function MapClickHandler({ onMapClick }) {
  useMapEvents({
    click(e) { onMapClick(e.latlng.lat, e.latlng.lng) },
  })
  return null
}

export default function ImageMap({ locations, pendingPos, onMapClick, onPinClick }) {
  const markerRefs = useRef({})

  return (
    <div className="rounded-xl overflow-hidden border border-slate-700" style={{ height: 360 }}>
      <MapContainer
        center={[57.7089, 11.9746]}
        zoom={12}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='© <a href="https://openstreetmap.org">OSM</a>'
        />

        <MapClickHandler onMapClick={onMapClick} />

        {/* Existing location pins */}
        {locations.map(loc => {
          const slotCount = Object.keys(loc.slots).length
          const icon = makeIcon(slotCount)
          const slotIcons = ['🌙','🌅','☀️','🌇'].map((ico, i) => {
            const key = ['night','morning','day','evening'][i]
            return loc.slots[key] ? ico : '·'
          }).join(' ')
          return (
            <Marker
              key={loc.label}
              position={[loc.lat, loc.lon]}
              icon={icon}
              eventHandlers={{
                click: () => onPinClick(loc),
                dragend: (e) => {
                  const { lat, lng } = e.target.getLatLng()
                  onPinClick({ ...loc, lat, lon: lng, fromDrag: true })
                },
              }}
              draggable={true}
            >
              <Tooltip direction="top" offset={[0, -30]} opacity={0.95}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{loc.label}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{slotIcons}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{slotCount}/4 slots</div>
              </Tooltip>
            </Marker>
          )
        })}

        {/* Pending click position */}
        {pendingPos && (
          <Marker position={[pendingPos.lat, pendingPos.lon]} icon={pendingIcon}>
            <Tooltip direction="top" offset={[0, -14]} opacity={0.95} permanent>
              <span style={{ fontSize: 12 }}>Ny plats här</span>
            </Tooltip>
          </Marker>
        )}
      </MapContainer>

      {/* Legend */}
      <div className="absolute bottom-2 right-2 bg-slate-900/80 rounded-lg px-3 py-2 text-xs text-slate-400 space-y-1 z-[1000] pointer-events-none">
        {[['#475569','Inga bilder'],['#f97316','1 slot'],['#eab308','2 slots'],['#22c55e','3 slots'],['#3b82f6','4 slots']].map(([c,l]) => (
          <div key={l} className="flex items-center gap-2">
            <span style={{ background: c }} className="w-2.5 h-2.5 rounded-full inline-block" />
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}
