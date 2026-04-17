/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home.sports

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import org.mozilla.fenix.R
import java.util.Locale

/**
 * A country participating in a sports tournament.
 *
 * @property countryCode ISO 3166-1 alpha-2 code (or subdivision code for England/Scotland).
 * @property flagResId Drawable resource ID for the country's flag.
 */
data class Country(
    val countryCode: String,
    @param:DrawableRes val flagResId: Int,
)

/**
 * A region grouping of participating countries in a sports tournament.
 *
 * @property nameResId String resource ID for the region's display name.
 * @property countries List of participating countries in this region.
 */
data class Region(
    @param:StringRes val nameResId: Int,
    val countries: List<Country>,
)

/**
 * Returns the localized display name for this country.
 *
 * England and Scotland use subdivision codes that require explicit string resources.
 */
fun Country.displayName(): String = when (countryCode) {
    "GB-ENG", "GB-SCT" -> countryCode
    else -> Locale.Builder().setRegion(countryCode).build()
        .getDisplayCountry(Locale.getDefault())
}

/**
 * All teams participating in a sports tournament grouped by region.
 */
val regionGrouping: List<Region> = listOf(
    Region(
        nameResId = R.string.sports_widget_confederation_north_america,
        countries = listOf(
            Country("CA", R.drawable.flag_ca),
            Country("MX", R.drawable.flag_mx),
            Country("US", R.drawable.flag_us),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_africa,
        countries = listOf(
            Country("DZ", R.drawable.flag_dz),
            Country("CV", R.drawable.flag_cv),
            Country("CD", R.drawable.flag_cd),
            Country("EG", R.drawable.flag_eg),
            Country("GH", R.drawable.flag_gh),
            Country("CI", R.drawable.flag_ci),
            Country("MA", R.drawable.flag_ma),
            Country("SN", R.drawable.flag_sn),
            Country("ZA", R.drawable.flag_za),
            Country("TN", R.drawable.flag_tn),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_asia,
        countries = listOf(
            Country("AU", R.drawable.flag_au),
            Country("IR", R.drawable.flag_ir),
            Country("IQ", R.drawable.flag_iq),
            Country("JP", R.drawable.flag_jp),
            Country("JO", R.drawable.flag_jo),
            Country("KR", R.drawable.flag_kr),
            Country("QA", R.drawable.flag_qa),
            Country("SA", R.drawable.flag_sa),
            Country("UZ", R.drawable.flag_uz),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_concacaf,
        countries = listOf(
            Country("CW", R.drawable.flag_cw),
            Country("HT", R.drawable.flag_ht),
            Country("PA", R.drawable.flag_pa),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_europe,
        countries = listOf(
            Country("AT", R.drawable.flag_at),
            Country("BE", R.drawable.flag_be),
            Country("BA", R.drawable.flag_ba),
            Country("HR", R.drawable.flag_hr),
            Country("CZ", R.drawable.flag_cz),
            Country("GB-ENG", R.drawable.flag_eng),
            Country("FR", R.drawable.flag_fr),
            Country("DE", R.drawable.flag_de),
            Country("NL", R.drawable.flag_nl),
            Country("NO", R.drawable.flag_no),
            Country("PT", R.drawable.flag_pt),
            Country("GB-SCT", R.drawable.flag_sct),
            Country("ES", R.drawable.flag_es),
            Country("SE", R.drawable.flag_se),
            Country("CH", R.drawable.flag_ch),
            Country("TR", R.drawable.flag_tr),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_oceania,
        countries = listOf(
            Country("NZ", R.drawable.flag_nz),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_south_america,
        countries = listOf(
            Country("AR", R.drawable.flag_ar),
            Country("BR", R.drawable.flag_br),
            Country("CO", R.drawable.flag_co),
            Country("EC", R.drawable.flag_ec),
            Country("PY", R.drawable.flag_py),
            Country("UY", R.drawable.flag_uy),
        ),
    ),
)
