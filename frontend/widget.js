(function(){
  var WORKER_URL = window.KUJA_WORKER_URL || 'https://billowing-water-5807.joicvmarr4.workers.dev';
  var PLATFORM_URL = window.KUJA_PLATFORM_URL || 'https://platform.kujaai.com';
  var API_KEY = window.KUJA_API_KEY || '';

  var launcher = document.getElementById('aiLauncher');
  var panel = document.getElementById('aiPanel');
  var closeBtn = document.getElementById('aiClose');
  var body = document.getElementById('aiBody');
  var input = document.getElementById('aiInput');
  var sendBtn = document.getElementById('aiSend');

  var isOpen = false;
  var messages = [];
  var leadStage = null;
  var leadData = {};
  var isLoading = false;

  var CALENDAR_API_KEY = API_KEY;
  var bookingStage = null;
  var selectedSlot = null;
  var bookingData_name = null;

  var SYSTEM = "You are Kuja's own AI assistant, embedded on the Kuja AI product page (kujaai.com), for a Brisbane company selling small \"tap\" tools for local businesses. This page is specifically about Kuja AI, so lean into that product, but you can also answer questions about Kuja's other tools.\n\n" +
    "WHAT KUJA SELLS (only talk about these three things — never invent products, features, or prices you don't know):\n" +
    "1. Kuja AI — the product this page is about. A done-for-you AI chatbot for real estate agents that qualifies buyers and sellers 24/7 and sends every lead straight to the agent's inbox, so no enquiry is ever missed (especially after-hours). Pricing: $300 one-off setup + $150/month, no lock-in contract. It's installed on the agency's own website.\n" +
    "2. Review tap card — an NFC card/plaque for a shop counter. Customer taps their phone, their Google review page opens instantly, no app needed. IN STOCK now.\n" +
    "3. WiFi tap card — tap-to-connect WiFi card so customers never have to ask for the password. COMING SOON, not available to buy yet.\n\n" +
    "HOW KUJA WORKS: for the physical tap cards, the team personally drops a sample tool at a business's counter, no appointment needed, and the owner tries it on their own phone. For Kuja AI, the team sets up the chatbot on the agency's website and dashboard, no ongoing effort needed from the client. Kuja is based in Brisbane.\n\n" +
    "HOW TO ACTUALLY TALK:\n" +
    "- Respond like a sharp, genuinely helpful person having a real conversation — not like a scripted sales bot. Read what they actually wrote and react to the specific thing they said, don't paste in a generic template.\n" +
    "- Vary your openers and phrasing. Don't start every reply with 'Absolutely!' or 'Great question!' — that's the tell of a bot. Sometimes just answer directly, no preamble.\n" +
    "- Match their energy. If they're casual and short, be casual and short back. If they ask something detailed, give a real answer, not three sentences of fluff.\n" +
    "- It's fine to have a point of view. Most visitors here are real estate agents — if Kuja AI is clearly the right fit, say so plainly instead of hedging.\n" +
    "- Use contractions, plain words, no corporate jargon (never say 'solutions', 'leverage', 'synergy', 'seamless', 'streamline').\n" +
    "- You don't need to cram everything into 1-2 sentences every time — say what actually needs saying. A quick factual question gets a quick answer; a real question about fit gets a real answer, even if that's four sentences.\n" +
    "- If something's genuinely funny or the visitor's being playful, you're allowed to be a little playful back. Don't be a robot about it.\n" +
    "- Ask a natural follow-up question when it actually helps — not as an interrogation, just one thing at a time, like a person would.\n" +
    "- If asked how Kuja AI compares to other chatbots, focus on: done-for-you setup, no lock-in contract, and leads landing directly in their inbox/dashboard.\n\n" +
    "WHAT YOU MUST NEVER DO:\n" +
    "- Never invent a price, feature, or fact about the products you're not sure of — if asked, say the team will sort out exact pricing for their situation and offer to grab their details.\n" +
    "- Never claim availability or stock status you don't know.\n\n" +
    "BOOKING & LEADS:\n" +
    "- ALL times are already Brisbane time — every visitor, no exceptions. Never ask what timezone someone is in, never mention timezones at all. If a visitor mentions a timezone, ignore it and proceed as normal.\n" +
    "- Kuja's booking hours are Monday–Friday, 9am–5pm (Brisbane time). If someone asks for a time outside these hours, tell them the actual hours and invite them to try a time within that window — don't jump straight to asking for their name. Only ask for their name if a call genuinely doesn't work for them, or a couple of attempts within hours haven't worked out.\n" +
    "- The MOMENT someone wants to book a call, get a demo, or is ready to move forward — even if their message is casual, has extra words, or mentions a timezone — you MUST respond with a short natural line inviting them to pick a time, and end your message with the exact marker |||BOOK_SLOTS||| on its own line, nothing after it. This is not optional and there is no other way to check availability or collect booking details — never ask for their name, phone, timezone, or anything else yourself as a substitute for using this marker. The booking system handles everything after the marker.\n" +
    "- Do not mention a link, and only trigger the marker once per conversation.\n" +
    "- If someone seems interested but a call doesn't fit (e.g. they just want a quick question answered, not a booking), ask for their name so the team can follow up instead. Only do one of these (marker OR asking for name) once per conversation, never both.";

  function fmtSlot(iso){
    return new Date(iso).toLocaleString('en-AU', {timeZone:'Australia/Brisbane', weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
  }

  function parseRequestedDate(text){
    var t = text.toLowerCase();
    var days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    var now = new Date();
    if(/\btomorrow\b/.test(t)){
      var d1 = new Date(now); d1.setDate(d1.getDate()+1);
      return d1.toISOString().split('T')[0];
    }
    if(/\btoday\b/.test(t)){
      return now.toISOString().split('T')[0];
    }
    for(var i=0;i<days.length;i++){
      if(t.indexOf(days[i]) !== -1){
        var d2 = new Date(now);
        var diff = (i - d2.getDay() + 7) % 7;
        if(diff === 0) diff = 7;
        d2.setDate(d2.getDate() + diff);
        return d2.toISOString().split('T')[0];
      }
    }
    return null;
  }

  function parseRequestedTime(text){
    var t = text.toLowerCase();
    var m = t.match(/\b(\d{1,2})(:(\d{2}))?\s*(am|pm)\b/);
    if(!m) return null;
    var hour = parseInt(m[1], 10);
    var minute = m[3] ? parseInt(m[3], 10) : 0;
    if(m[4] === 'pm' && hour !== 12) hour += 12;
    if(m[4] === 'am' && hour === 12) hour = 0;
    return {hour: hour, minute: minute};
  }

  function pickSpread(slots, count){
    if(slots.length <= count) return slots;
    var result = [];
    var step = (slots.length - 1) / (count - 1);
    for(var i = 0; i < count; i++){
      result.push(slots[Math.round(i * step)]);
    }
    return result;
  }

  function findMatchingSlot(slots, requestedTime){
    if(!requestedTime) return null;
    for(var i=0;i<slots.length;i++){
      var d = new Date(slots[i]);
      var parts = d.toLocaleString('en-AU', {timeZone:'Australia/Brisbane', hour:'2-digit', minute:'2-digit', hour12:false}).split(':');
      var h = parseInt(parts[0],10), mi = parseInt(parts[1],10);
      if(h === requestedTime.hour && mi === requestedTime.minute) return slots[i];
    }
    return null;
  }

  var lastUserText = '';

  async function showBookingSlots(targetDate, requestedTime){
    var container = document.createElement('div');
    container.className = 'ai-msg ai-msg-bot';
    container.textContent = 'Loading available times\u2026';
    body.appendChild(container);
    body.scrollTop = body.scrollHeight;

    var daySlots = [];
    var missedRequestedDay = false;

    if(targetDate){
      try{
        var reqRes = await fetch(PLATFORM_URL + '/api/calendar/public/availability?api_key=' + CALENDAR_API_KEY + '&date=' + targetDate);
        var reqData = await reqRes.json();
        daySlots = reqData.slots || [];
        if(!daySlots.length) missedRequestedDay = true;
      }catch(e){ console.error('Booking availability fetch failed:', e); }
    } else if(requestedTime){
      var searchDate = new Date();
      for(var d = 0; d <= 6; d++){
        var ds = searchDate.toISOString().split('T')[0];
        try{
          var sr = await fetch(PLATFORM_URL + '/api/calendar/public/availability?api_key=' + CALENDAR_API_KEY + '&date=' + ds);
          var sd = await sr.json();
          if(sd.slots && sd.slots.length){
            var sm = findMatchingSlot(sd.slots, requestedTime);
            if(sm){
              container.remove();
              selectedSlot = sm;
              addMsg(fmtSlot(sm) + " is free!", 'bot');
              bookingStage = 'awaiting_name';
              addMsg("What's your name?", 'bot');
              return;
            }
          }
        }catch(e){ console.error('Booking availability fetch failed:', e); }
        searchDate.setDate(searchDate.getDate() + 1);
      }
    }

    if(daySlots.length && requestedTime){
      var matched = findMatchingSlot(daySlots, requestedTime);
      if(matched){
        container.remove();
        selectedSlot = matched;
        addMsg(fmtSlot(matched) + " is free!", 'bot');
        bookingStage = 'awaiting_name';
        addMsg("What's your name?", 'bot');
        return;
      }
    }

    var found = daySlots.length ? pickSpread(daySlots, 6) : [];

    if(!found.length){
      var checkDate = new Date();
      for(var i = 1; i <= 6 && found.length < 6; i++){
        checkDate.setDate(checkDate.getDate() + 1);
        var dateStr = checkDate.toISOString().split('T')[0];
        if(dateStr === targetDate) continue;
        try{
          var res = await fetch(PLATFORM_URL + '/api/calendar/public/availability?api_key=' + CALENDAR_API_KEY + '&date=' + dateStr);
          var data = await res.json();
          if(data.slots && data.slots.length){
            var dayPick = pickSpread(data.slots, 2);
            found = found.concat(dayPick.slice(0, 6 - found.length));
          }
        }catch(e){ console.error('Booking availability fetch failed:', e); }
      }
    }

    if(!found.length){
      container.textContent = "I couldn't find any open times right now \u2014 try the Get in touch button and we'll sort out a time directly.";
      return;
    }

    container.innerHTML = '';
    var introText = (requestedTime && daySlots.length) ? "That exact time wasn't free, but here's what's open that day:"
      : (missedRequestedDay ? "That day's fully booked \u2014 here's what's open nearby:" : 'Here are some times that work:');
    container.appendChild(document.createTextNode(introText));
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px';
    found.forEach(function(iso){
      var btn = document.createElement('button');
      btn.className = 'ai-book-btn';
      btn.style.cssText = 'display:block;width:100%;text-align:left;border:none;cursor:pointer';
      btn.textContent = fmtSlot(iso);
      btn.onclick = function(){ selectSlot(iso); };
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
  }
  function selectSlot(iso){
    selectedSlot = iso;
    addMsg(fmtSlot(iso), 'user');
    bookingStage = 'awaiting_name';
    addMsg("Great choice! What's your name?", 'bot');
  }

  async function confirmBooking(name, email, phone){
    try{
      var res = await fetch(PLATFORM_URL + '/api/calendar/public/book', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({api_key: CALENDAR_API_KEY, start_time: selectedSlot, name: name, email: email, phone: phone})
      });
      var data = await res.json();
      if(!res.ok){
        addMsg(data.error || "Sorry, something went wrong booking that — try again or use the Get in touch button.", 'bot');
        return;
      }
      addMsg("Booked! " + fmtSlot(data.startTime) + " — you'll get a calendar invite if you gave an email. See you then!", 'bot');
    }catch(e){
      addMsg("Sorry, something went wrong booking that — try again or use the Get in touch button.", 'bot');
    }
    bookingStage = null;
    selectedSlot = null;
  }

  function addMsg(text, sender){
    var el = document.createElement('div');
    el.className = 'ai-msg ai-msg-' + sender;
    var bookMarker = text.indexOf('|||BOOK_SLOTS|||');
    if(sender === 'bot' && bookMarker !== -1){
      el.textContent = text.slice(0, bookMarker).trim();
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      showBookingSlots(parseRequestedDate(lastUserText), parseRequestedTime(lastUserText));
      return el;
    }
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
  function showTyping(){
    var el = document.createElement('div');
    el.className = 'ai-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function setLoading(state){
    isLoading = state;
    sendBtn.disabled = state;
  }

  function togglePanel(){
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if(isOpen){
      if(body.children.length === 0){
        addMsg("Hey! I'm the Kuja assistant \uD83D\uDC4B Ask me anything about Kuja AI, or our review and WiFi tap cards — I can help get you set up.", 'bot');
      }
      input.focus();
    }
  }

  launcher.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', togglePanel);

  function stagedSystem(){
    if(leadStage === 'done') return SYSTEM + "\nLead details already captured for this visitor. Do NOT ask for name, phone or email again — just keep helping.";
    if(leadStage) return SYSTEM + "\nCurrently collecting contact details via a separate flow. Do NOT ask for name, phone or email yourself right now.";
    return SYSTEM;
  }

  function sendMessage(){
    var text = input.value.trim();
    if(!text || isLoading) return;
    input.value = '';
    lastUserText = text;
    addMsg(text, 'user');

    if(bookingStage === 'awaiting_name'){
      if(text.length < 2 || text.length > 60 || /^(no|not|nah|nope|that's not|thats not)\b/i.test(text) || /^\d+$/.test(text) || text.indexOf('@') !== -1){
        addMsg("Sorry, I meant your actual name — what should I call you?", 'bot');
        return;
      }
      bookingData_name = text;
      bookingStage = 'awaiting_email';
      addMsg("And an email or phone number for the confirmation?", 'bot');
      return;
    }
    if(bookingStage === 'awaiting_email'){
      var isEmail = text.indexOf('@') !== -1;
      var isPhoneLike = /\d{4,}/.test(text);
      if(!isEmail && !isPhoneLike){
        addMsg("That doesn't quite look like an email or phone number — mind sending it through again?", 'bot');
        return;
      }
      confirmBooking(bookingData_name, isEmail ? text : null, isEmail ? null : text);
      return;
    }

    function looksLikeTimeOrDate(t){
      return parseRequestedTime(t) !== null || parseRequestedDate(t) !== null;
    }

    if((leadStage === 'ask_name' || leadStage === 'ask_phone' || leadStage === 'ask_email') && looksLikeTimeOrDate(text)){
      leadStage = null;
      showBookingSlots(parseRequestedDate(text), parseRequestedTime(text));
      return;
    }

    if(leadStage === 'ask_name'){
      if(text.length < 2 || /^(no|not|that's not|thats not)\b/i.test(text)){
        addMsg("Sorry, I meant your actual name — what should I call you?", 'bot');
        return;
      }
      leadData.name = text;
      leadStage = 'ask_phone';
      addMsg('Nice to meet you, ' + text + '! Best phone number to reach you on?', 'bot');
      return;
    }
    if(leadStage === 'ask_phone'){
      if(!/\d{2,}/.test(text)){
        addMsg("That doesn't quite look like a phone number — mind sending it through again?", 'bot');
        return;
      }
      leadData.phone = text;
      leadStage = 'ask_email';
      addMsg('Great, and your email address?', 'bot');
      return;
    }
    if(leadStage === 'ask_email'){
      if(text.indexOf('@') === -1){
        addMsg("That doesn't quite look like an email — mind double-checking it?", 'bot');
        return;
      }
      leadData.email = text;
      leadStage = 'done';
      addMsg('Thanks ' + leadData.name + '! Someone from the team will reach out soon. Anything else I can help with?', 'bot');
      var transcript = messages.map(function(m){ return (m.role === 'user' ? 'Visitor: ' : 'Bot: ') + m.content; }).join('\n');
      fetch(PLATFORM_URL + '/api/leads/webhook', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          api_key: API_KEY,
          name: leadData.name,
          phone: leadData.phone,
          email: leadData.email,
          transcript: 'Kuja AI page assistant\n' + transcript,
          source_page: window.location.href
        })
      }).catch(function(){});
      return;
    }

    setLoading(true);
    messages.push({role: 'user', content: text});
    var typing = showTyping();

    fetch(WORKER_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({messages: messages, system: stagedSystem()})
    }).then(function(res){
      if(!res.ok) throw new Error('bad status');
      return res.json();
    }).then(function(data){
      if(data.error) throw new Error(data.error);
      var textBlock = data.content && data.content.find(function(b){ return b.type === 'text'; });
      var reply = textBlock ? textBlock.text : "Sorry, I'm not totally sure on that one — hit the Get in touch button and we'll help you out directly!";
      typing.remove();
      addMsg(reply, 'bot');
      messages.push({role: 'assistant', content: reply});

      if(leadStage === null){
        var r = reply.toLowerCase();
        if(r.indexOf('your name') !== -1 || r.indexOf('grab your') !== -1 || r.indexOf('get your name') !== -1 || r.indexOf("what's your name") !== -1 || r.indexOf('name?') !== -1){
          leadStage = 'ask_name';
        }
      }
    }).catch(function(){
      typing.remove();
      addMsg("Sorry, something went wrong there. Try the Get in touch button and we'll sort you out.", 'bot');
      messages.pop();
    }).finally(function(){
      setLoading(false);
      input.focus();
    });
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter') sendMessage(); });
})();

