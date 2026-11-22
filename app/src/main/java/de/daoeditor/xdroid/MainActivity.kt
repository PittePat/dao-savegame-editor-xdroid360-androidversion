package de.daoeditor.xdroid

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Hosts the touch UI (assets/www) in a WebView. All savegame logic runs in Python (Chaquopy, python/bridge.py).
 * The ZIP chosen by the user is copied into the app's private storage; edits happen on that copy and are
 * written back (or exported as a new file) only when the user asks for it.
 */
class MainActivity : AppCompatActivity() {

    /** ACTION_OPEN_DOCUMENT with write permission, so the original ZIP can optionally be overwritten. */
    private class OpenZip : ActivityResultContracts.OpenDocument() {
        override fun createIntent(context: Context, input: Array<String>): Intent =
            super.createIntent(context, input).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    private lateinit var web: WebView
    private lateinit var workFile: File
    private val worker = Executors.newSingleThreadExecutor()   // one thread: Python session state is not thread-safe
    private var sourceUri: Uri? = null
    private var displayName = "savegame.zip"
    private var pageReady = false
    private val queued = mutableListOf<String>()

    private val pickLauncher = registerForActivityResult(OpenZip()) { uri ->
        if (uri == null) emit("cancel", JSONObject()) else importUri(uri)
    }

    private val exportLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        if (uri == null) emit("cancel", JSONObject()) else worker.execute {
            val r = try {
                contentResolver.openOutputStream(uri, "w")!!.use { out -> workFile.inputStream().use { it.copyTo(out) } }
                result(true, "Gespeichert: ${nameOf(uri) ?: "neue ZIP"}")
            } catch (e: Exception) {
                result(false, "Speichern fehlgeschlagen: ${e.message}")
            }
            emit("exported", r.put("final", r.optBoolean("ok")))
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        workFile = File(filesDir, "work/current.zip").also { it.parentFile?.mkdirs() }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.setSupportZoom(false)
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                // never leave the local page
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    queued.forEach { js -> view.evaluateJavascript(js, null) }
                    queued.clear()
                }
            }
            addJavascriptInterface(NativeBridge(), "Android")
        }
        setContentView(web)
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.onBack && window.onBack()") { handled ->
                    if (handled == "true") return@evaluateJavascript
                    web.evaluateJavascript("window.isDirty && window.isDirty()") { dirty ->
                        if (dirty == "true") {
                            AlertDialog.Builder(this@MainActivity)
                                .setTitle("Ungespeicherte Änderungen")
                                .setMessage("Wirklich beenden? Nicht gespeicherte Änderungen gehen verloren.")
                                .setPositiveButton("Beenden") { _, _ -> finish() }
                                .setNegativeButton("Abbrechen", null)
                                .show()
                        } else finish()
                    }
                }
            }
        })

        handleViewIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleViewIntent(intent)
    }

    private fun handleViewIntent(i: Intent?) {
        val uri = i?.data
        if (i?.action == Intent.ACTION_VIEW && uri != null) importUri(uri)
    }

    // ---------------------------------------------------------------- file handling

    private fun nameOf(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    } catch (e: Exception) { null }

    private fun result(ok: Boolean, msg: String) = JSONObject().put("ok", ok).put("msg", msg)

    private fun importUri(uri: Uri) = worker.execute {
        try {
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            } catch (e: Exception) { /* not offered by this provider - fine */ }
            workFile.delete()
            val copied = contentResolver.openInputStream(uri)!!.use { input ->
                workFile.outputStream().use { input.copyTo(it) }
            }
            if (copied > 300L * 1024 * 1024) { workFile.delete(); throw IllegalStateException("Datei ist zu groß") }
            sourceUri = uri
            displayName = nameOf(uri) ?: "savegame.zip"
            emit("picked", JSONObject().put("path", workFile.absolutePath).put("name", displayName))
        } catch (e: Exception) {
            emit("exported", result(false, "Datei konnte nicht gelesen werden: ${e.message}"))
        }
    }

    // ---------------------------------------------------------------- native -> JS

    private fun emit(name: String, payload: JSONObject) =
        js("window.onNative(${JSONObject.quote(name)}, ${JSONObject.quote(payload.toString())})")

    private fun js(code: String) = runOnUiThread {
        if (pageReady) web.evaluateJavascript(code, null) else queued.add(code)
    }

    // ---------------------------------------------------------------- JS -> native

    inner class NativeBridge {
        @JavascriptInterface
        fun call(id: Int, method: String, args: String) {
            worker.execute {
                val res = try {
                    Python.getInstance().getModule("bridge").callAttr("call", method, args).toString()
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: e.toString()).toString()
                }
                js("window.__resolve($id, ${JSONObject.quote(res)})")
            }
        }

        @JavascriptInterface
        fun pickZip() = runOnUiThread { pickLauncher.launch(arrayOf("*/*")) }

        @JavascriptInterface
        fun exportZip() = runOnUiThread {
            val base = displayName.removeSuffix(".zip").removeSuffix(".ZIP")
            exportLauncher.launch("${base}_bearbeitet.zip")
        }

        @JavascriptInterface
        fun writeBack() {
            worker.execute {
                val uri = sourceUri
                val r = if (uri == null) result(false, "Kein Originalort bekannt - bitte als neue ZIP speichern")
                else try {
                    contentResolver.openOutputStream(uri, "wt")!!.use { out -> workFile.inputStream().use { it.copyTo(out) } }
                    result(true, "Original überschrieben")
                } catch (e: Exception) {
                    result(false, "Original nicht beschreibbar - bitte als neue ZIP speichern (${e.message})")
                }
                emit("writeback", r.put("final", r.optBoolean("ok")))
            }
        }
    }
}
