#!KAMAILIO
# Centralino SIP del Giornale Lavori — versione 2 (11/10/2026)
# WhatsApp (Meta) → Kamailio → ElevenLabs (italiano e altre lingue, audio convertito da rtpengine Opus→G.722)
#                            → OpenAI Realtime (albanese, audio diretto)
# Segnaposto: __IP__ (indirizzo pubblico, messo dal server), __ALBANESI__ (numeri albanesi, messi da Supabase)
debug=2
log_stderror=no
log_facility=LOG_LOCAL0
children=4
tcp_children=4
enable_tls=yes
disable_tcp=no
auto_aliases=no
listen=tls:__IP__:5061 advertise sip.ilgiornalelavori.it:5061
alias="sip.ilgiornalelavori.it:5061"
tcp_connection_lifetime=3605
tcp_accept_no_cl=yes

loadmodule "kex.so"
loadmodule "corex.so"
loadmodule "tm.so"
loadmodule "tmx.so"
loadmodule "sl.so"
loadmodule "rr.so"
loadmodule "pv.so"
loadmodule "maxfwd.so"
loadmodule "textops.so"
loadmodule "siputils.so"
loadmodule "xlog.so"
loadmodule "pike.so"
loadmodule "tls.so"
loadmodule "rtpengine.so"

modparam("tls", "config", "/etc/kamailio/tls.cfg")
modparam("tls", "xavp_cfg", "tls")
modparam("rr", "enable_full_lr", 1)
modparam("rr", "append_fromtag", 1)
modparam("pike", "sampling_time_unit", 2)
modparam("pike", "reqs_density_per_unit", 16)
modparam("pike", "remove_latency", 4)
modparam("rtpengine", "rtpengine_sock", "udp:127.0.0.1:2223")

request_route {
  if (!mf_process_maxfwd_header("10")) { sl_send_reply("483", "Too Many Hops"); exit; }
  if (!pike_check_req()) { exit; }
  if (is_method("OPTIONS") && uri==myself) { sl_send_reply("200", "OK"); exit; }

  if (has_totag()) {
    if (loose_route()) {
      if (check_route_param("gl=el")) {
        if (is_method("BYE")) {
          xlog("L_NOTICE", "GL audio della chiamata: $rtpstat\n");
          rtpengine_delete();
        } else if (is_method("INVITE|UPDATE") && has_body("application/sdp")) {
          # re-INVITE/UPDATE: da Meta verso ElevenLabs come la prima offerta; da ElevenLabs verso Meta al contrario (Opus/SRTP)
          if (is_direction("downstream")) {
            rtpengine_offer("replace-origin ICE=remove RTP/AVP rtcp-mux-accept rtcp-mux-demux codec-mask-opus codec-transcode-G722 codec-transcode-PCMA codec-transcode-PCMU");
          } else {
            rtpengine_offer("replace-origin ICE=remove RTP/SAVP rtcp-mux-offer codec-mask-G722 codec-mask-PCMA codec-mask-PCMU codec-transcode-opus");
          }
          t_on_reply("GL_RISPOSTA_EL");
        }
      }
      if ($rd =~ "openai") { $xavp(tls=>server_name) = "sip.api.openai.com"; }
      else if ($rd =~ "elevenlabs") { $xavp(tls=>server_name) = "sip.rtc.elevenlabs.io"; }
      xlog("L_NOTICE", "GL in-dialog $rm da $si verso $ru\n");
      t_relay();
      exit;
    }
    if (is_method("ACK")) { if (t_check_trans()) { t_relay(); } exit; }
    sl_send_reply("404", "Not here");
    exit;
  }

  if (is_method("CANCEL")) {
    if (t_check_trans()) { rtpengine_delete(); t_relay(); }
    exit;
  }
  if (!is_method("INVITE")) { sl_send_reply("405", "Method Not Allowed"); exit; }
  if (!is_present_hf("X-Wa-Meta-Wacid")) {
    xlog("L_NOTICE", "GL INVITE rifiutato (senza X-Wa-Meta-Wacid) da $si ru=$ru\n");
    sl_send_reply("403", "Forbidden");
    exit;
  }
  xlog("L_NOTICE", "GL INVITE da $si chiamante=$fU wacid=$hdr(X-Wa-Meta-Wacid)\n");
  remove_hf("X-GL-Centralino");
  remove_hf("X-GL-Lingua");

  if ($fU =~ "^\+?(__ALBANESI__)$") {
    route(ALBANESE);
  } else {
    route(ELEVENLABS);
  }
  exit;
}

# Albanese: assistente OpenAI Realtime (l'audio va diretto tra Meta e OpenAI)
route[ALBANESE] {
  xlog("L_NOTICE", "GL instradata: albanese → OpenAI\n");
  append_hf("X-GL-Centralino: __TOKEN__\r\n");
  append_hf("X-GL-Lingua: sq\r\n");
  $ru = "sip:__PROJ__@sip.api.openai.com:5061;transport=tls";
  $xavp(tls=>server_name) = "sip.api.openai.com";
  record_route();
  t_on_reply("GL_RISPOSTA");
  t_on_failure("GL_FALLITA");
  if (!t_relay()) { xlog("L_NOTICE", "GL t_relay non riuscito (OpenAI)\n"); sl_reply_error(); }
}

# Tutti gli altri: assistente ElevenLabs (audio Opus/SRTP di WhatsApp convertito in G.722/RTP da rtpengine)
route[ELEVENLABS] {
  xlog("L_NOTICE", "GL instradata: ElevenLabs\n");
  $ru = "sip:+393783107501@sip.rtc.elevenlabs.io:5061;transport=tls";
  $xavp(tls=>server_name) = "sip.rtc.elevenlabs.io";
  if (!rtpengine_offer("replace-origin ICE=remove RTP/AVP rtcp-mux-accept rtcp-mux-demux codec-mask-opus codec-transcode-G722 codec-transcode-PCMA codec-transcode-PCMU")) {
    xlog("L_NOTICE", "GL rtpengine_offer non riuscito\n");
    sl_send_reply("503", "Media non disponibile");
    exit;
  }
  record_route(";gl=el");
  t_on_reply("GL_RISPOSTA_EL");
  t_on_failure("GL_FALLITA_EL");
  if (!t_relay()) {
    xlog("L_NOTICE", "GL t_relay non riuscito (ElevenLabs)\n");
    rtpengine_delete();
    sl_reply_error();
  }
}

onreply_route[GL_RISPOSTA] { xlog("L_NOTICE", "GL risposta $rs $rr da $si\n"); }
failure_route[GL_FALLITA] { xlog("L_NOTICE", "GL chiamata fallita codice $T_reply_code\n"); }

onreply_route[GL_RISPOSTA_EL] {
  xlog("L_NOTICE", "GL risposta EL $rs $rr da $si\n");
  if (has_body("application/sdp")) {
    # nessun protocollo forzato: rtpengine risponde a Meta con lo stesso che Meta ha offerto (RTP/SAVP o RTP/SAVPF)
    if (!rtpengine_answer("replace-origin ICE=remove")) {
      xlog("L_NOTICE", "GL rtpengine_answer non riuscito\n");
    }
  }
}
failure_route[GL_FALLITA_EL] {
  xlog("L_NOTICE", "GL chiamata EL fallita codice $T_reply_code\n");
  rtpengine_delete();
}
