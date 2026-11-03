'use strict';
(function () {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  function create({ send, onChange } = {}) {
    let room = null, selfId = null, stream = null, micOn = false, busy = false, error = '';
    const peers = new Map(), speaking = new Set(), meters = new Map(), pendingIce = new Map();
    let audioContext = null, meterTimer = null;
    function snapshot() { return { enabled: !!room?.voiceEnabled, joined: peers.size > 0, micOn, busy, error }; }
    function changed() { try { onChange?.(snapshot()); } catch {} }
    function markSpeaking(id, active) { const had = speaking.has(id); if (active) speaking.add(id); else speaking.delete(id); if (had !== active) changed(); }
    function sendSignal(id, data) { if (room?.voiceEnabled && id && data) send?.('voice.signal', { targetId: id, data }); }
    function removeMeter(id) { const meter=meters.get(id); if(meter){try{meter.source.disconnect();meter.analyser.disconnect();}catch{}meters.delete(id);} markSpeaking(id,false); }
    function addMeter(id, media) { if(!audioContext||meters.has(id)||!media)return; try{const source=audioContext.createMediaStreamSource(media),analyser=audioContext.createAnalyser();analyser.fftSize=512;source.connect(analyser);meters.set(id,{source,analyser,data:new Uint8Array(analyser.fftSize)});}catch{} }
    function ensureAudioContext() {
      const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;
      if(!audioContext)audioContext=new Audio();audioContext.resume?.().catch(()=>{});
      for(const [id,peer] of peers)if(peer.remoteStream)addMeter(id,peer.remoteStream);
      if(stream)addMeter(selfId,stream);
      for(const peer of peers.values())if(peer.audio)peer.audio.play?.().catch(()=>{});
      if(!meterTimer)meterTimer=setInterval(()=>{for(const [id,meter]of meters){meter.analyser.getByteTimeDomainData(meter.data);let sum=0;for(const value of meter.data){const n=(value-128)/128;sum+=n*n;}markSpeaking(id,Math.sqrt(sum/meter.data.length)>.035);}},110);
    }
    function closePeer(id){const peer=peers.get(id);if(!peer)return;try{peer.pc.close();}catch{}if(peer.audio){peer.audio.pause();peer.audio.srcObject=null;peer.audio.remove();}removeMeter(id);pendingIce.delete(id);peers.delete(id);}
    function clearAll(){for(const id of Array.from(peers.keys()))closePeer(id);for(const id of Array.from(meters.keys()))removeMeter(id);if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;}micOn=false;busy=false;error='';if(meterTimer){clearInterval(meterTimer);meterTimer=null;}if(audioContext){try{audioContext.close();}catch{}audioContext=null;}speaking.clear();}
    function ensurePeer(id){
      if(peers.has(id))return peers.get(id);
      const pc=new RTCPeerConnection({iceServers:ICE}),transceiver=pc.addTransceiver('audio',{direction:'sendrecv'}),peer={pc,transceiver,audio:null,remoteStream:null};peers.set(id,peer);
      pc.onicecandidate=event=>{if(event.candidate)sendSignal(id,{type:'candidate',candidate:event.candidate.toJSON?event.candidate.toJSON():event.candidate});};
      pc.ontrack=event=>{const media=event.streams?.[0]||new MediaStream([event.track]);peer.remoteStream=media;if(!peer.audio){peer.audio=document.createElement('audio');peer.audio.autoplay=true;peer.audio.playsInline=true;peer.audio.setAttribute('aria-hidden','true');document.body.appendChild(peer.audio);}peer.audio.srcObject=media;peer.audio.play?.().catch(()=>{});addMeter(id,media);event.track.onended=()=>removeMeter(id);};
      pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'||pc.connectionState==='closed')markSpeaking(id,false);};
      return peer;
    }
    async function makeOffer(id,peer){if(peer.pc.signalingState!=='stable'||peer.pc.localDescription)return;try{const offer=await peer.pc.createOffer();await peer.pc.setLocalDescription(offer);sendSignal(id,{type:'offer',sdp:peer.pc.localDescription});}catch{error='Could not establish voice with one player';changed();}}
    async function sync(nextRoom,id){
      if(!nextRoom?.voiceEnabled||!id||!['lobby','playing'].includes(nextRoom.status)){room=null;selfId=null;clearAll();changed();return;}
      room=nextRoom;selfId=id;error='';const members=nextRoom.players.filter(p=>p.id!==id&&p.connected).map(p=>p.id);
      for(const existing of Array.from(peers.keys()))if(!members.includes(existing))closePeer(existing);
      for(const otherId of members){const peer=ensurePeer(otherId);if(selfId.localeCompare(otherId)<0&&!peer.pc.localDescription)await makeOffer(otherId,peer);}
      changed();
    }
    async function handleSignal(message){
      if(!room?.voiceEnabled||!message?.fromId||!message.data||!room.players.some(p=>p.id===message.fromId))return;
      const id=message.fromId,peer=ensurePeer(id),pc=peer.pc,data=message.data;
      try{
        if(data.type==='offer'){await pc.setRemoteDescription(data.sdp);const candidates=pendingIce.get(id)||[];pendingIce.delete(id);for(const candidate of candidates)await pc.addIceCandidate(candidate);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);sendSignal(id,{type:'answer',sdp:pc.localDescription});}
        else if(data.type==='answer'){await pc.setRemoteDescription(data.sdp);const candidates=pendingIce.get(id)||[];pendingIce.delete(id);for(const candidate of candidates)await pc.addIceCandidate(candidate);}
        else if(data.type==='candidate'&&data.candidate){if(pc.remoteDescription)await pc.addIceCandidate(data.candidate);else pendingIce.set(id,[...(pendingIce.get(id)||[]),data.candidate]);}
      }catch{error='A voice connection could not be completed';changed();}
    }
    async function toggle(){
      if(!room?.voiceEnabled)return;error='';
      if(!stream){busy=true;changed();try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});micOn=true;const track=stream.getAudioTracks()[0];for(const peer of peers.values())await peer.transceiver.sender.replaceTrack(track);ensureAudioContext();}
      catch(cause){if(stream)stream.getTracks().forEach(track=>track.stop());stream=null;micOn=false;error=cause?.name==='NotAllowedError'?'Microphone permission was denied. Allow it in your browser settings.':'Could not access your microphone on this device.';}
      finally{busy=false;changed();}return;}
      micOn=!micOn;stream.getAudioTracks().forEach(track=>{track.enabled=micOn;});changed();
    }
    function isSpeaking(id){return speaking.has(id);}
    function getState(){return snapshot();}
    function destroy(){room=null;selfId=null;clearAll();changed();}
    window.addEventListener('beforeunload',destroy);
    return {sync,handleSignal,toggle,isSpeaking,getState,destroy};
  }
  window.ParcheesiVoice={create};
})();