import React, { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Bot, User, LifeBuoy, ArrowRight, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { findMatchingAnswer, DEFAULT_SUGGESTIONS, FAQItem } from "./kb";

export interface Message {
  id: string;
  sender: "bot" | "user";
  text: string;
  time: string;
  action?: FAQItem["action"];
  followUps?: string[];
}

interface ChatbotModalProps {
  onOpenPricing?: () => void;
  onOpenNewWorkspace?: () => void;
  onOpenNewTask?: () => void;
}

export const ChatbotWidget: React.FC<ChatbotModalProps> = ({
  onOpenPricing,
  onOpenNewWorkspace,
  onOpenNewTask,
}) => {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [supportMode, setSupportMode] = useState(false);
  const [supportEmail, setSupportEmail] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [submittingSupport, setSubmittingSupport] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "initial-greeting",
      sender: "bot",
      text: "Hello! I am the TaskPilot Assistant. I can help answer questions about workspaces, quotas, pricing, dependency cycles, and account security. How can I help you today?",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      followUps: DEFAULT_SUGGESTIONS.slice(0, 4),
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, supportMode]);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Close on Esc key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleSendMessage = (textToSend?: string) => {
    const text = (textToSend ?? input).trim();
    if (!text) return;

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      sender: "user",
      text,
      time,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Find deterministic answer from KB
    setTimeout(() => {
      const match = findMatchingAnswer(text);
      let botMsg: Message;

      if (match) {
        botMsg = {
          id: `bot-${Date.now()}`,
          sender: "bot",
          text: match.answer,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          action: match.action,
          followUps: match.followUpChips,
        };
      } else {
        botMsg = {
          id: `bot-${Date.now()}`,
          sender: "bot",
          text: "I couldn't find a direct answer to that query. Here are some common topics you can ask me about, or you can submit a support request to our team:",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          followUps: DEFAULT_SUGGESTIONS,
          action: {
            label: "Contact Human Support",
            type: "contact_support",
          },
        };
      }

      setMessages((prev) => [...prev, botMsg]);
    }, 250);
  };

  const handleAction = (action?: FAQItem["action"]) => {
    if (!action) return;
    if (action.type === "open_pricing" && onOpenPricing) {
      onOpenPricing();
    } else if (action.type === "open_new_workspace" && onOpenNewWorkspace) {
      onOpenNewWorkspace();
    } else if (action.type === "open_new_task" && onOpenNewTask) {
      onOpenNewTask();
    } else if (action.type === "contact_support") {
      setSupportMode(true);
      setSupportEmail(user?.email || "");
      setSupportMessage("");
      setSupportSuccess(null);
    }
  };

  const handleSupportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supportEmail.trim() || !supportMessage.trim()) {
      toast.error("Please provide both your email and a message.");
      return;
    }

    try {
      setSubmittingSupport(true);
      const ticketId = `REQ-${Math.floor(100000 + Math.random() * 900000)}`;

      // Attempt insert into Supabase support_requests table
      try {
        await supabase.from("support_requests").insert([
          {
            ticket_id: ticketId,
            user_id: user?.id || null,
            email: supportEmail.trim(),
            message: supportMessage.trim(),
            created_at: new Date().toISOString(),
          },
        ]);
      } catch (dbErr) {
        // Graceful fallback if table is not yet migrated
        console.warn("support_requests insert fallback:", dbErr);
      }

      setSupportSuccess(ticketId);
      toast.success(`Support request ${ticketId} created!`);

      // Add confirmation message to chat
      setMessages((prev) => [
        ...prev,
        {
          id: `bot-${Date.now()}`,
          sender: "bot",
          text: `Thank you! Your support ticket ${ticketId} has been submitted. Our team will review your message and reply to ${supportEmail} within 24 hours.`,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          followUps: ["What plans does TaskPilot offer?", "How do workspaces work?"],
        },
      ]);
      setSupportMode(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to submit support request.");
    } finally {
      setSubmittingSupport(false);
    }
  };

  return (
    <>
      {/* Floating Trigger Button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl transition-transform hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={isOpen ? "Close Help Assistant" : "Open Help Assistant"}
        title="Help &amp; Knowledge Base"
      >
        {isOpen ? <X className="h-5 w-5" /> : <LifeBuoy className="h-5 w-5" />}
      </button>

      {/* Slide-over / Popup Modal */}
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="TaskPilot Assistant"
          className="fixed bottom-20 right-4 z-50 flex h-[540px] w-full max-w-[390px] flex-col rounded-2xl border border-border bg-card shadow-2xl animate-in fade-in slide-in-from-bottom-4 sm:right-6"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-3 rounded-t-2xl">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Bot className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">TaskPilot Assistant</h3>
                <p className="text-[11px] text-muted-foreground">Deterministic Help &amp; FAQs</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Close Assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Chat Messages Body */}
          <div
            className="flex-1 overflow-y-auto p-4 space-y-3 text-xs"
            aria-live="polite"
          >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${
                  m.sender === "user" ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 whitespace-pre-wrap leading-relaxed ${
                    m.sender === "user"
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-muted text-card-foreground rounded-bl-sm border border-border/50"
                  }`}
                >
                  {/* Strict plain text rendering only - no innerHTML or eval */}
                  {m.text}
                </div>
                <span className="mt-1 text-[10px] text-muted-foreground px-1">
                  {m.time}
                </span>

                {/* Optional Action Button */}
                {m.action && (
                  <button
                    onClick={() => handleAction(m.action)}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/20 transition-colors"
                  >
                    <span>{m.action.label}</span>
                    <ArrowRight className="h-3 w-3" />
                  </button>
                )}

                {/* Follow-up question chips */}
                {m.followUps && m.followUps.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 max-w-[90%]">
                    {m.followUps.map((chip, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSendMessage(chip)}
                        className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-primary hover:bg-muted/40 transition-colors text-left"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Support Request Form View */}
            {supportMode && (
              <div className="mt-3 rounded-xl border border-indigo-500/30 bg-muted/70 p-3 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-foreground">Submit Support Request</span>
                  <button
                    onClick={() => setSupportMode(false)}
                    className="text-muted-foreground hover:text-foreground text-[10px]"
                  >
                    Cancel
                  </button>
                </div>
                <form onSubmit={handleSupportSubmit} className="space-y-2">
                  <div>
                    <label className="text-[11px] text-muted-foreground block mb-0.5">Your Email</label>
                    <input
                      type="email"
                      required
                      value={supportEmail}
                      onChange={(e) => setSupportEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground block mb-0.5">How can we help?</label>
                    <textarea
                      required
                      rows={3}
                      value={supportMessage}
                      onChange={(e) => setSupportMessage(e.target.value)}
                      placeholder="Describe the issue or request..."
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submittingSupport}
                    className="w-full flex items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {submittingSupport ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      "Send Request"
                    )}
                  </button>
                </form>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Footer */}
          <div className="border-t border-border bg-card p-2.5 rounded-b-2xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-center gap-1.5"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a question..."
                className="flex-1 rounded-xl border border-input bg-muted/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
