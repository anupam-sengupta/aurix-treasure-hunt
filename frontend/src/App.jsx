import React, { useEffect, useState } from 'react'
import './styles.css'

const COOLDOWN_KEY = 'th_cooldown_until'
const fmt = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`

export default function App() {
  const [team, setTeam] = useState('')
  const [pin, setPin] = useState('')
  const [step, setStep] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [remaining, setRemaining] = useState(null)

  const API = import.meta.env.VITE_API_BASE || ''
  const LOGO = import.meta.env.VITE_LOGO_URL || '/logo.png'
  const BG = import.meta.env.VITE_BG_IMAGE_URL || '/bg.jpg'

  // Apply background via CSS var so it can be dynamic
  useEffect(() => {
    document.documentElement.style.setProperty('--bg-image', `url("${BG}")`)
  }, [BG])

  // Restore cooldown on load (refresh-safe)
  useEffect(() => {
    const until = Number(localStorage.getItem(COOLDOWN_KEY) || 0)
    if (until > Date.now()) setCooldown(Math.ceil((until - Date.now())/1000))
    else localStorage.removeItem(COOLDOWN_KEY)
  }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const id = setInterval(() => {
      setCooldown((c) => {
        const next = c - 1
        if (next <= 0) {
            localStorage.removeItem(COOLDOWN_KEY)
            setRemaining(null)
            setErr('')    // clear the red message here
        }
        return next
      })
    }, 1000)
    return () => clearInterval(id)
  }, [cooldown])

  async function submit(e) {
    e.preventDefault()
    setErr(''); setMsg(''); setCopied(false)
    if (cooldown > 0) { setErr(`Please wait ${fmt(cooldown)} before next attempt.`); return }

    setLoading(true)
    try {
      const tn = Number(team), sn = Number(step)
      if (!Number.isInteger(tn) || tn < 1) throw new Error('Team Sequence number must be ≥ 1')
      if (!pin.trim()) throw new Error('Team is required')
      if (!Number.isInteger(sn) || sn < 1) throw new Error('Step number must be ≥ 1')
      if (!input.trim()) throw new Error('Input clue is required')

      const resp = await fetch(`${API}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamNumber: tn, teamPin: pin, stepNumber: sn, inputClue: input })
      })

      // Read rate-limit headers
      const limit = Number(resp.headers.get('ratelimit-limit') || 0)
      const rem   = Number(resp.headers.get('ratelimit-remaining') || NaN)
      const reset = Number(resp.headers.get('ratelimit-reset') || 0)
      if (!Number.isNaN(rem)) setRemaining(rem)

      // Proactive lock if out of attempts
      if (limit && rem === 0 && resp.status !== 200) {
        const secs = reset > 0 && reset < 600 ? reset : 60
        const until = Date.now() + secs * 1000
        localStorage.setItem(COOLDOWN_KEY, String(until))
        setCooldown(secs); setRemaining(null)
        throw new Error(`No attempts left. Please wait.`)
          // setErr('')
      }
      if (resp.status === 429) {
        const secs = reset > 0 && reset < 600 ? reset : 60
        const until = Date.now() + secs * 1000
        localStorage.setItem(COOLDOWN_KEY, String(until))
        setCooldown(secs); setRemaining(null)
        throw new Error(`Too many attempts. Please wait ${fmt(secs)}.`)
      }

      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'Request failed')

      setMsg(data.outputClue)
      setRemaining(null)
    } catch (e) {
      setErr(e.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function copyHint() {
    if (!msg) return
    try {
      await navigator.clipboard.writeText(msg)
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  const disabled = loading || cooldown > 0 || remaining === 0

  return (
    <div className="container">
         <header className="headerbar header-hero">
          <img className="logo logo-big" src={LOGO} alt="Logo"
               onError={(e)=>{e.currentTarget.style.display='none'}} />
          <h1 className="brand-title">Treasure Hunt</h1>
        </header>

      <main className="main">
        <div className="card" role="region" aria-label="Clue form">
                <div className="help">Enter your <b>Team Seq #</b>, <b>Team</b>, <b>Step #</b>, and the <b>Answer</b>.</div>

          <form onSubmit={submit} noValidate>
            {/*<div className="row">*/}
            {/*  <div>*/}
            {/*    <label htmlFor="team">Team Number</label>*/}
            {/*    <input id="team" type="number" min="1" value={team}*/}
            {/*           onChange={e=>setTeam(e.target.value)} placeholder="e.g., 1" disabled={disabled}/>*/}
            {/*  </div>*/}
            {/*  <div>*/}
            {/*    <label htmlFor="pin">Team PIN</label>*/}
            {/*    <input id="pin" type="text" value={pin}*/}
            {/*           onChange={e=>setPin(e.target.value)} placeholder="e.g., 4529" disabled={disabled}/>*/}
            {/*  </div>*/}
            {/*</div>*/}

              <div className="row-inline">
              <div>
                <label htmlFor="team">Team Seq Number</label>
                <input id="team" type="number" min="1" value={team}
                  onChange={e => setTeam(e.target.value)}  placeholder="e.g., 1" disabled={disabled}/>
              </div>
              <div>
                <label htmlFor="pin">Team</label>
                <input id="pin" type="text" value={pin}
                  onChange={e => setPin(e.target.value)} placeholder="secret" disabled={disabled}/>
              </div>
            </div>

            <label htmlFor="step">Step Number</label>
            <input id="step" type="number" min="1" value={step}
                   onChange={e=>setStep(e.target.value)} placeholder="e.g., 2" disabled={disabled}/>

            <label htmlFor="clue">Your Answer </label>
            <input id="clue" type="text" value={input}
                   onChange={e=>setInput(e.target.value)} placeholder="e.g., START123" disabled={disabled}/>

            <button disabled={disabled}>
                    {loading ? 'Checking…' : 'Get Next Hint'}
            </button>
            {cooldown > 0 && (
              <div className="timer" aria-live="polite">
                Next attempt available in <b>{fmt(cooldown)}</b>.
              </div>
            )}
          </form>

          {remaining !== null && cooldown === 0 && (
            <div className="help" style={{marginTop: 8}}>
              Attempts left before Timeout: <b>{remaining}</b>
            </div>
          )}

          {err && <div className="alert err">{err}</div>}
            {/*{err && <div className="alert err">Error: {err}</div>}*/}

          {msg && (
            <div className="alert ok">
              <div><b>Your next hint:</b></div>
              <div className="hint" style={{marginTop: 6}}>{msg}</div>
              <button className="copy" onClick={copyHint} disabled={copied}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        Good luck, explorers! 🔎
      </footer>
    </div>
  )
}
