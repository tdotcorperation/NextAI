import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { PaperAirplaneIcon, PlusIcon, UserCircleIcon, ChatBubbleLeftIcon } from '@heroicons/react/24/solid';

// Helper component to render message content with formatting
const MessageContent = ({ content }) => {
  // Regex to find **bold** text
  const boldRegex = /\*\*(.*?)\*\*/g;
  // Regex to find URLs within parentheses: (https://example.com)
  const urlRegex = /\((https?:\/\/[^\s]+)\)/g;

  const parts = [];
  let currentText = content;
  let lastIndex = 0;
  let match;

  // First, process URLs and replace them with a placeholder or remove them from the main text
  const urls = [];
  currentText = currentText.replace(urlRegex, (fullMatch, url) => {
    urls.push(url);
    return ''; // Remove the URL and its parentheses from the main text for bold processing
  });

  // Then, process bold text in the modified content
  while ((match = boldRegex.exec(currentText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`text-${lastIndex}`}>{currentText.substring(lastIndex, match.index)}</span>);
    }
    parts.push(<strong key={`bold-${match.index}`}>{match[1]}</strong>);
    lastIndex = boldRegex.lastIndex;
  }
  if (lastIndex < currentText.length) {
    parts.push(<span key={`text-${lastIndex}`}>{currentText.substring(lastIndex)}</span>);
  }

  return (
    <>
      <p className="text-base leading-relaxed break-words">{parts}</p>
      {urls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {urls.map((url, index) => (
            <a
              key={`link-${index}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-1 bg-blue-500 text-white text-sm rounded-full hover:bg-blue-600 transition-colors duration-200"
            >
              Go to Link
            </a>
          ))}
        </div>
      )}
    </>
  );
};

const Chat = () => {
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]); // { id, role: 'user' | 'assistant', content: string, created_at }
  const [conversations, setConversations] = useState([]); // { id, title, created_at }
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Fetch user's conversations on load
  useEffect(() => {
    const fetchConversations = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching conversations:', error);
      } else {
        setConversations(data);
        if (data.length > 0) {
          // Load the most recent conversation by default
          handleSelectConversation(data[0].id);
        } else {
          // Start a new chat if no conversations exist
          handleNewChat();
        }
      }
    };

    fetchConversations();
  }, []); // Run once on component mount

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewChat = () => {
    setCurrentConversationId(null);
    setMessages([]);
    setMessage('');
  };

  const handleSelectConversation = async (conversationId) => {
    setCurrentConversationId(conversationId);
    setLoading(true);
    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching messages:', error);
    } else {
      setMessages(data);
    }
    setLoading(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (message.trim() === '') return;

    const userMessage = { role: 'user', content: message, created_at: new Date().toISOString() };
    setMessages((prevMessages) => [...prevMessages, userMessage]);
    setMessage('');
    setLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Please log in to chat.');
        setLoading(false);
        return;
      }

      let conversationIdToUse = currentConversationId;
      let conversationTitle = 'New Chat';

      // If it's a new conversation, create one first
      if (!conversationIdToUse) {
        // Use first few words of the user's message as title
        conversationTitle = userMessage.content.substring(0, 30) + (userMessage.content.length > 30 ? '...' : '');
        const { data: newConversation, error: convError } = await supabase
          .from('conversations')
          .insert({ user_id: session.user.id, title: conversationTitle })
          .select()
          .single();

        if (convError) throw convError;
        conversationIdToUse = newConversation.id;
        setCurrentConversationId(newConversation.id);
        setConversations((prev) => [newConversation, ...prev]);
      }

      // Save user message to DB
      await supabase.from('messages').insert({
        conversation_id: conversationIdToUse,
        role: userMessage.role,
        content: userMessage.content,
      });

      // Call Supabase Edge Function
      const response = await fetch(
        `https://bxrvnuqaqsxqbpvfknvc.supabase.co/functions/v1/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ messages: [...messages, userMessage] }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch from Edge Function');
      }

      const aiResponseContent = await response.text();
      const aiMessage = { role: 'assistant', content: aiResponseContent, created_at: new Date().toISOString() };

      setMessages((prevMessages) => [...prevMessages, aiMessage]);

      // Save AI message to DB
      await supabase.from('messages').insert({
        conversation_id: conversationIdToUse,
        role: aiMessage.role,
        content: aiMessage.content,
      });

    } catch (error) {
      console.error('Error during chat:', error);
      alert((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex h-screen bg-[#202123] text-white">
      {/* Sidebar */}
      <div className="w-64 bg-[#202123] flex flex-col p-4 border-r border-gray-700">
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <button
            className="w-full flex items-center justify-center py-2 px-3 mb-4 border border-gray-700 rounded-md hover:bg-gray-700 transition-colors duration-200 text-sm"
            onClick={handleNewChat}
          >
            <PlusIcon className="h-4 w-4 mr-2" />
            New Chat
          </button>
          {/* Conversation List */}
          <div className="space-y-2">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                className={`w-full text-left py-1.5 px-3 rounded-md flex items-center space-x-2 ${currentConversationId === conv.id ? 'bg-gray-700' : 'hover:bg-gray-700'
                  } transition-colors duration-200 text-sm`}
                onClick={() => handleSelectConversation(conv.id)}
              >
                <ChatBubbleLeftIcon className="h-4 w-4 text-gray-400" />
                <span className="text-sm truncate">{conv.title}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-gray-700 pt-4">
          <button
            className="w-full flex items-center py-2 px-3 rounded-md hover:bg-gray-700 transition-colors duration-200 text-sm"
            onClick={handleLogout}
          >
            <UserCircleIcon className="h-4 w-4 mr-2" />
            Logout
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-[#343541]">
        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {messages.map((msg, index) => (
            <div
              key={index}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[70%] px-4 py-3 rounded-xl shadow-md ${msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-none' // User message background and shape
                  : 'bg-gray-600 text-white rounded-bl-none' // AI message background and shape
                }`}
              >
                <MessageContent content={msg.content} />
                <p className="text-xs text-gray-300 mt-1 text-right">{formatTimestamp(msg.created_at)}</p>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="max-w-[70%] px-4 py-3 rounded-xl bg-gray-600 text-white shadow-md rounded-bl-none">
                {/* Thinking GIF/Spinner */}
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Message Input */}
        <div className="p-4 bg-[#202123] border-t border-gray-700">
          <form onSubmit={handleSendMessage} className="flex items-center max-w-3xl mx-auto">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message Gemini..."
              rows={1} // Start with 1 row
              className="flex-1 border border-gray-600 bg-[#40414F] text-white rounded-xl py-4 px-6 mr-3 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors duration-200 resize-none overflow-hidden"
              disabled={loading}
              style={{ minHeight: '56px', maxHeight: '200px' }} // Adjust min/max height as needed
            />
            <button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white p-4 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors duration-200 aspect-square"
              disabled={loading}
            >
              <PaperAirplaneIcon className="h-8 w-8 transform rotate-90" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Chat;