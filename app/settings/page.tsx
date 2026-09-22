"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Topic } from "../../lib/card-cluster";
import type { ContextItem } from "../../lib/context-items";

type TopicDraft = { id?: string; label: string; hint: string };
type ContextDraft = { id?: string; text: string };

export default function SettingsPage() {
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [contextDraft, setContextDraft] = useState<ContextDraft | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [editingTopic, setEditingTopic] = useState<TopicDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  function load() {
    return Promise.all([
      fetch("/api/state?view=working&light=1", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/topics", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([state, list]) => {
      setContextItems(state.contextItems ?? []);
      setTopics(list.topics ?? []);
    });
  }
  useEffect(() => { void load(); }, []);

  async function saveContext() {
    if (!contextDraft?.text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/context", {
        method: contextDraft.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(contextDraft),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Context could not be saved.");
      setContextDraft(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Context could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function removeContext(id: string) {
    if (!window.confirm("Remove this context note? Agency will stop using it for discovery and new work.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/context?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Context could not be removed.");
      if (contextDraft?.id === id) setContextDraft(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Context could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTopic() {
    if (!editingTopic || !editingTopic.label.trim()) return;
    setBusy(true);
    await fetch("/api/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editingTopic) });
    setEditingTopic(null); await load(); setBusy(false);
  }
  async function removeTopic(id: string) {
    if (!window.confirm("Remove this topic? Its cards stay and show under All until they are refiled.")) return;
    setBusy(true);
    await fetch(`/api/topics?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load(); setBusy(false);
  }

  return (
    <main className="stats-shell settings-shell">
      <header className="stats-header">
        <Link href="/" className="stats-back">← Back</Link>
        <h1 className="settings-title">Settings</h1>
        <span />
      </header>

      <section className="settings-block">
        <div className="settings-head">
          <h2>Context</h2>
          <p>Add anything Agency should remember when discovering or working: priorities, responsibilities, preferences, and what to ignore.</p>
        </div>
        {contextItems.length ? (
          <ul className="settings-context-list">
            {contextItems.map((item) => (
              <li key={item.id}>
                <p>{item.text}</p>
                <div className="settings-row-actions">
                  <button onClick={() => { setError(""); setContextDraft({ id: item.id, text: item.text }); }}>Edit</button>
                  <button className="is-danger" disabled={busy} onClick={() => void removeContext(item.id)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="settings-context-empty"><strong>Give Agency its first piece of context</strong><span>You can add more whenever your focus changes.</span></div>
        )}
        {contextDraft ? (
          <div className="settings-context-editor">
            <label htmlFor="context-note">{contextDraft.id ? "Edit context" : "New context"}</label>
            <textarea id="context-note" value={contextDraft.text} onChange={(event) => setContextDraft({ ...contextDraft, text: event.target.value })} placeholder="For example: Ignore routine medical-records messages unless someone asks for my decision." />
            <small>Try a priority, responsibility, preference, or something discovery should ignore.</small>
            {error && <p className="settings-error" role="alert">{error}</p>}
            <div className="settings-actions">
              <button disabled={busy} onClick={() => { setContextDraft(null); setError(""); }}>Cancel</button>
              <button className="is-dark" disabled={busy || !contextDraft.text.trim()} onClick={() => void saveContext()}>{contextDraft.id ? "Save changes" : "Add context"}</button>
            </div>
          </div>
        ) : (
          <div className="settings-actions"><button className="is-dark" onClick={() => setContextDraft({ text: "" })}>Add context</button></div>
        )}
      </section>

      <section className="settings-block settings-connections">
        <div className="settings-head">
          <h2>Connected apps</h2>
          <p>Agency uses the tools and accounts already available to your local Claude session. Credentials are never stored in this app.</p>
        </div>
        <div className="settings-source-list" aria-label="Common Agency sources">
          {['Slack', 'Granola', 'Notion', 'Gmail', 'Calendar', 'GitHub'].map((source) => <span key={source}>{source}</span>)}
        </div>
        <div className="settings-connection-note">
          <div><strong>Check access from Claude</strong><span>Claude performs a harmless live read and reports Connected, Needs sign-in, or Unavailable for each useful source.</span></div>
          <button onClick={() => { void navigator.clipboard.writeText('npm run agency:claude').then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy start command'}</button>
        </div>
      </section>

      <section className="settings-block">
        <div className="settings-head">
          <h2>Topics</h2>
          <p>Name a topic and describe it. Your agent uses these topics when making cards.</p>
        </div>
        <ul className="settings-topics">
          {topics.map((topic) => (
            <li key={topic.id}>
              <div>
                <strong>{topic.label}</strong>
                <span>{topic.hint || "no description"}</span>
              </div>
              <div className="settings-row-actions">
                <button onClick={() => setEditingTopic({ id: topic.id, label: topic.label, hint: topic.hint })}>Edit</button>
                <button className="is-danger" onClick={() => void removeTopic(topic.id)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        {editingTopic ? (
          <div className="settings-editor">
            <label><span>Name</span><input value={editingTopic.label} onChange={(event) => setEditingTopic({ ...editingTopic, label: event.target.value })} placeholder="e.g. Hiring" /></label>
            <label><span>Description</span><input value={editingTopic.hint} onChange={(event) => setEditingTopic({ ...editingTopic, hint: event.target.value })} placeholder="What belongs here" maxLength={120} /></label>
            <div className="settings-actions">
              <button onClick={() => setEditingTopic(null)}>Cancel</button>
              <button className="is-dark" disabled={!editingTopic.label.trim() || busy} onClick={() => void saveTopic()}>{editingTopic.id ? "Save topic" : "Add topic"}</button>
            </div>
          </div>
        ) : (
          <div className="settings-actions"><button className="is-dark" onClick={() => setEditingTopic({ label: "", hint: "" })}>Add topic</button></div>
        )}
      </section>
    </main>
  );
}
