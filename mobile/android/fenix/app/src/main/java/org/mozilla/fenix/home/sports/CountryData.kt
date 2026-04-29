/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home.sports

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import org.mozilla.fenix.R

/**
 * A country participating in a sports tournament.
 *
 * @property countryCode 3-letter country code used by the tournament (e.g. CAN, MEX, USA).
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
 * All teams participating in a sports tournament grouped by region.
 */
val regionGrouping: List<Region> = listOf(
    Region(
        nameResId = R.string.sports_widget_confederation_north_america,
        countries = listOf(
            Country(countryCode = "CAN", flagResId = R.drawable.flag_ca),
            Country(countryCode = "MEX", flagResId = R.drawable.flag_mx),
            Country(countryCode = "USA", flagResId = R.drawable.flag_us),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_africa,
        countries = listOf(
            Country(countryCode = "ALG", flagResId = R.drawable.flag_dz),
            Country(countryCode = "CPV", flagResId = R.drawable.flag_cv),
            Country(countryCode = "COD", flagResId = R.drawable.flag_cd),
            Country(countryCode = "EGY", flagResId = R.drawable.flag_eg),
            Country(countryCode = "GHA", flagResId = R.drawable.flag_gh),
            Country(countryCode = "CIV", flagResId = R.drawable.flag_ci),
            Country(countryCode = "MAR", flagResId = R.drawable.flag_ma),
            Country(countryCode = "SEN", flagResId = R.drawable.flag_sn),
            Country(countryCode = "RSA", flagResId = R.drawable.flag_za),
            Country(countryCode = "TUN", flagResId = R.drawable.flag_tn),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_asia,
        countries = listOf(
            Country(countryCode = "AUS", flagResId = R.drawable.flag_au),
            Country(countryCode = "IRN", flagResId = R.drawable.flag_ir),
            Country(countryCode = "IRQ", flagResId = R.drawable.flag_iq),
            Country(countryCode = "JPN", flagResId = R.drawable.flag_jp),
            Country(countryCode = "JOR", flagResId = R.drawable.flag_jo),
            Country(countryCode = "KOR", flagResId = R.drawable.flag_kr),
            Country(countryCode = "QAT", flagResId = R.drawable.flag_qa),
            Country(countryCode = "KSA", flagResId = R.drawable.flag_sa),
            Country(countryCode = "UZB", flagResId = R.drawable.flag_uz),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_concacaf,
        countries = listOf(
            Country(countryCode = "CUW", flagResId = R.drawable.flag_cw),
            Country(countryCode = "HAI", flagResId = R.drawable.flag_ht),
            Country(countryCode = "PAN", flagResId = R.drawable.flag_pa),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_europe,
        countries = listOf(
            Country(countryCode = "AUT", flagResId = R.drawable.flag_at),
            Country(countryCode = "BEL", flagResId = R.drawable.flag_be),
            Country(countryCode = "BIH", flagResId = R.drawable.flag_ba),
            Country(countryCode = "CRO", flagResId = R.drawable.flag_hr),
            Country(countryCode = "CZE", flagResId = R.drawable.flag_cz),
            Country(countryCode = "ENG", flagResId = R.drawable.flag_eng),
            Country(countryCode = "FRA", flagResId = R.drawable.flag_fr),
            Country(countryCode = "GER", flagResId = R.drawable.flag_de),
            Country(countryCode = "NED", flagResId = R.drawable.flag_nl),
            Country(countryCode = "NOR", flagResId = R.drawable.flag_no),
            Country(countryCode = "POR", flagResId = R.drawable.flag_pt),
            Country(countryCode = "SCO", flagResId = R.drawable.flag_sct),
            Country(countryCode = "ESP", flagResId = R.drawable.flag_es),
            Country(countryCode = "SWE", flagResId = R.drawable.flag_se),
            Country(countryCode = "SUI", flagResId = R.drawable.flag_ch),
            Country(countryCode = "TUR", flagResId = R.drawable.flag_tr),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_oceania,
        countries = listOf(
            Country(countryCode = "NZL", flagResId = R.drawable.flag_nz),
        ),
    ),
    Region(
        nameResId = R.string.sports_widget_confederation_south_america,
        countries = listOf(
            Country(countryCode = "ARG", flagResId = R.drawable.flag_ar),
            Country(countryCode = "BRA", flagResId = R.drawable.flag_br),
            Country(countryCode = "COL", flagResId = R.drawable.flag_co),
            Country(countryCode = "ECU", flagResId = R.drawable.flag_ec),
            Country(countryCode = "PAR", flagResId = R.drawable.flag_py),
            Country(countryCode = "URU", flagResId = R.drawable.flag_uy),
        ),
    ),
)
